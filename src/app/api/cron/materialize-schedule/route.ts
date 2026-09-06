import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runForwardMaterializer } from '@/lib/schedule/materializeForward';
import { reconcileClaims } from '@/lib/schedule/reconcile';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: FORWARD SCHEDULE MATERIALIZER (Vercel cron, daily — see vercel.json).
// Generates shift_instances four weeks forward from active template-linked shift_rules. This is
// the NEW materializer (Deploy B). It never writes `shifts` and never touches payroll — the
// past-materializer (/api/cron/materialize-shifts) is a separate job and out of scope here.
//
// SAFETY RAMP: writes are gated behind SCHEDULE_MATERIALIZE_FORWARD_WRITE_ENABLED, mirroring
// SHIFT_MATERIALIZE_WRITE_ENABLED on the past-materializer.
//   • unset / anything but "true"  → LOG-ONLY (default): plans + logs what it WOULD create,
//     writes NOTHING. A `?dry-run` / `?dry_run` query param forces log-only even if the flag is on.
//   • "true"                       → upserts the planned set (ON CONFLICT DO NOTHING).
// ── TENANCY OF THE RESPONSE ──────────────────────────────────────────────────────────────────
// This job is GLOBAL by design: the materializer sweeps every account's active rules and the
// reconciliation backstop must catch drift in any account. That is correct for the CRON, but the
// same handler also accepts an authenticated admin — one tenant's admin — and it used to hand that
// caller the raw global output. Two separate disclosures rode in one JSON body:
//   • `reconcile`      — other accounts' shift_instances ids, attendance_events ids, and a global
//                        pending-claim count
//   • `result.sample`  — up to 10 planned rows, each carrying another account's user_id,
//                        employee_id, shift_rule_id, store_id and shift times
// plus the global aggregate counts (rules_processed / candidates / inserted / skipped_*), which
// leak how much other tenants have on their schedules.
//
// The fix keeps the job global and changes only WHAT EACH CALLER IS TOLD:
//   cron  → unchanged in every respect: global sweep, global reconcile, full body.
//   admin → the job still runs globally (its write behaviour is untouched), reconciliation is
//           re-run SCOPED TO THEIR OWN ACCOUNT, and the global materializer detail is withheld.
// Server-side console logs are unchanged for both — they are operator output, never a response.
type Caller = { kind: 'cron' } | { kind: 'admin'; ownerId: string };

export async function GET(req: Request) {
  // ── Auth: only Vercel cron (Bearer CRON_SECRET) or a logged-in admin. Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let caller: Caller | null = null;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    caller = { kind: 'cron' }; // Vercel cron invocation
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    // An admin session IS the account, so the uid is the tenant to scope to.
    if (user?.app_metadata?.role === 'admin') caller = { kind: 'admin', ownerId: user.id };
  }
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const forceDryRun = url.searchParams.has('dry-run') || url.searchParams.has('dry_run');
  const writeEnabled = process.env.SCHEDULE_MATERIALIZE_FORWARD_WRITE_ENABLED === 'true' && !forceDryRun;

  try {
    const result = await runForwardMaterializer({ write: writeEnabled });
    const mode = writeEnabled ? 'WRITE' : 'LOG_ONLY';

    console.log(
      `[cron/materialize-schedule] mode=${mode} today=${result.today} window=${result.window.from}..${result.window.to} ` +
        `rules=${result.rules_processed} candidates=${result.candidates} ` +
        `to_insert=${result.to_insert_count} inserted=${result.inserted} ` +
        `skipped_guard=${result.skipped_by_guard} skipped_conflict=${result.skipped_by_conflict}`,
    );
    for (const s of result.sample) {
      console.log(
        `[cron/materialize-schedule] ${writeEnabled ? 'INSERT' : 'WOULD_INSERT'} ` +
          `emp=${s.employee_id} rule=${s.shift_rule_id} ${s.shift_date} ${s.starts_at}→${s.ends_at}`,
      );
    }

    // Reconciliation sweep (read-only) — surfaces the non-atomic-claim drift and unresolved OT
    // (pending) claims in the same daily log. Runs regardless of write mode; failure here must not
    // fail the cron (it's diagnostics), so it's isolated.
    let reconcile = null;
    try {
      // Cron sweeps everything; an admin sweeps only their own account.
      reconcile = await reconcileClaims(caller.kind === 'admin' ? caller.ownerId : undefined);
      console.log(
        `[cron/materialize-schedule] reconcile pending_claims=${reconcile.pending_claims} ` +
          `claimed_without_event=${reconcile.claimed_without_event.length} ` +
          `event_without_claimed_instance=${reconcile.event_without_claimed_instance.length}`,
      );
      if (reconcile.pending_claims > 0) {
        console.warn(`[cron/materialize-schedule] ⚠ ${reconcile.pending_claims} PENDING OT claim(s) awaiting approval (no UI until Phase 7)`);
      }
      if (reconcile.claimed_without_event.length > 0) {
        console.error(`[cron/materialize-schedule] ⚠ claimed instances missing 'claimed' event: ${reconcile.claimed_without_event.join(',')}`);
      }
      if (reconcile.event_without_claimed_instance.length > 0) {
        console.error(`[cron/materialize-schedule] ⚠ 'claimed' events with no claimed instance: ${reconcile.event_without_claimed_instance.join(',')}`);
      }
    } catch (e) {
      console.error('[cron/materialize-schedule] reconcile failed (non-fatal):', (e as Error).message);
    }

    const mode_out = writeEnabled ? 'write' : 'log_only';
    if (caller.kind === 'admin') {
      // `result` describes work done across EVERY account — its `sample` carries other tenants'
      // user_id/employee_id/shift_rule_id outright, and its counts are global totals. None of it is
      // this admin's to see, and none of it is needed to confirm the run happened. `reconcile` here
      // is already scoped to them by the call above. `detail_withheld` says why the shape differs,
      // so a caller is never left guessing whether the job silently did nothing.
      return NextResponse.json({
        mode: mode_out,
        today: result.today,
        window: result.window,
        reconcile,
        detail_withheld: 'global',
      });
    }
    return NextResponse.json({ mode: mode_out, ...result, reconcile });
  } catch (e) {
    console.error('[cron/materialize-schedule] error:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
