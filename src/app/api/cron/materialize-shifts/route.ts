import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { materializePastShifts } from '@/lib/shifts/materialize';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET: scheduled RECURRING-SHIFT MATERIALIZER (Vercel cron, daily — see vercel.json).
// Freezes each active rule's PAST recurring days into real `shifts` rows so worked
// history can't be erased by deleting/deactivating/editing the rule. Calls the SAME
// verified core as any manual trigger (@/lib/shifts/materialize); this route only adds
// cron auth + the write safety-ramp + logging.
//
// SAFETY RAMP: writes are gated behind SHIFT_MATERIALIZE_WRITE_ENABLED (it writes
// PAYROLL rows, so it ships LOG-ONLY for the first cycle so one run can be reviewed).
//   • unset / anything but "true"  → LOG-ONLY (default): computes + logs what it WOULD
//     materialize, writes NOTHING.
//   • "true"                       → actually upserts the would-materialize set.
// Writing is additive + idempotent (partial unique index + ON CONFLICT DO NOTHING).
//
// ACCEPTED RESIDUAL GAP (by design): a day that became past since the last cron run AND
// whose rule is deleted/deactivated by DIRECT SQL in that window is not yet frozen. App
// deletes/deactivations are covered by the pre-mutation freeze; the DB-trigger hardening
// that would close the direct-SQL window was deliberately not built (not worth it at
// this scale). Once a day IS materialized, ON DELETE SET NULL keeps it forever.
export async function GET(req: Request) {
  // ── Auth: only Vercel cron (Bearer CRON_SECRET) or a logged-in admin. Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    authorized = true; // Vercel cron invocation
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.role === 'admin') authorized = true; // admin manual trigger
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Safety ramp: default OFF (log-only) until explicitly enabled.
  const writeEnabled = process.env.SHIFT_MATERIALIZE_WRITE_ENABLED === 'true';

  try {
    const result = await materializePastShifts({ write: writeEnabled });
    const mode = writeEnabled ? 'WRITE' : 'LOG_ONLY';

    // Distinct, greppable logs for the watch period.
    console.log(
      `[cron/materialize-shifts] mode=${mode} rules=${result.rules_scanned} would_materialize=${result.would_materialize_count} materialized=${result.materialized}`,
    );
    for (const w of result.would_materialize) {
      console.log(
        `[cron/materialize-shifts] ${writeEnabled ? 'MATERIALIZED' : 'WOULD_MATERIALIZE'} ${JSON.stringify(w)}`,
      );
    }

    return NextResponse.json({ mode: writeEnabled ? 'write' : 'log_only', ...result });
  } catch (e) {
    console.error('[cron/materialize-shifts] error:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
