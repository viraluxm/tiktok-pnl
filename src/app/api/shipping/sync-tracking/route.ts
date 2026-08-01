import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Packer-facing tracking recovery — a one-click pre-flight after label purchase. Reconciles
// synced_order_ids.tracking_number against TikTok (getOrderById, authoritative). Two write paths:
//
//   FILL     — stored tracking is NULL, live is non-empty → write it. Non-destructive (COALESCE
//              behaviour), how fresh orders that arrived NULL get their first tracking.
//   CORRECT  — stored tracking is NON-NULL but DIFFERS from live → OVERWRITE it. TikTok re-labels
//              combine shipments (one consolidated label → N per-package labels), so a stored value
//              can be SUPERSEDED; the old COALESCE-safe guard protected that stale value forever and
//              its physical label could never scan. Correction is authoritative-wins, but strictly
//              guarded: only when the API actually RETURNED the order WITH a non-empty tracking —
//              a missing/empty response NEVER overwrites (that would turn a stale value into none).
//              Every overwrite is logged to tracking_correction_log (order_id, old, new) so a bad
//              sweep is traceable and fully reversible.
//
// Gated by store_members membership, scoped to ONE store. NON-ADMIN.
//
// TARGET SET — LIVE status, not stored: candidates are selected from a BROAD open-status set
// (CORE_OPEN, incl. ON_HOLD / PARTIALLY_SHIPPING) precisely because our stored `status` is a
// create-day snapshot and FREEZES (an order that became AWAITING_COLLECTION after its create-day
// was last synced stays stuck as e.g. ON_HOLD in our DB — see PR #74 refresh-status). The OLD
// filter here was [AWAITING_COLLECTION, AWAITING_SHIPMENT], which silently skipped 99 pack-ready
// Snore orders frozen at ON_HOLD (live-AWAITING_COLLECTION with a bought label). We now pull the
// wider candidate set and let getOrderById's LIVE result decide: fill/correct fire only on a
// non-empty live tracking, so genuinely-held orders (no label) are naturally no-ops.
//
// WRITE GATE: INFORMATIONAL ONLY — never refuses. It reports the most-recent auction write
// (capture_events / live_auction_items) for observability, but does NOT block writes. The old 409
// refusal was cargo-culted from PR #74; this route writes synced_order_ids.tracking_number, a table
// disjoint from the auction path, so there is no contention to gate against. Safe to run mid-live.
//
// GET  ?store_id=…  → coverage for the store (total_ac, with_tracking, missing_tracking).
// POST { store_id, dry_run?, correct?, after? }
//   dry_run (default TRUE)  → report proposed FILLs and CORRECTIONs (the latter grouped by combine
//                             group, stored→live, with counts) and write NOTHING.
//   correct (default TRUE)  → include the stale-overwrite path; false = fill-only (legacy behaviour).
//   Re-invoke with `next_after` (keyset by order_id) until done.

// Open/non-terminal statuses whose stored value may be a stale snapshot of a live-packable order.
// Matches PR #74's CORE_OPEN so both passes reason about the same frozen-status set.
const TARGET_STATUSES = ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT', 'ON_HOLD', 'PARTIALLY_SHIPPING'];
const ACTIVITY_WINDOW_MIN = 15;  // informational readout only (gate no longer enforced)
const CALL_BUDGET = 80;          // 80 × 50-id calls ≈ 4000 orders/invocation, < maxDuration
const TIME_BUDGET_MS = 240_000;
const MAX_429_RETRIES = 3;       // rate-limit backoff (mirrors refresh-status): retry, don't 502
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Most-recent auction write across capture_events + live_auction_items → the deploy/write gate.
async function writeGateStatus(admin: ReturnType<typeof createAdminClient>) {
  const latest = async (table: string): Promise<number | null> => {
    const { data } = await admin.from(table).select('created_at').order('created_at', { ascending: false }).limit(1);
    const ts = data?.[0]?.created_at as string | undefined;
    return ts ? new Date(ts).getTime() : null;
  };
  const [capTs, itemTs] = await Promise.all([latest('capture_events'), latest('live_auction_items')]);
  const lastMs = Math.max(capTs ?? 0, itemTs ?? 0) || null;
  const minutesSince = lastMs ? (Date.now() - lastMs) / 60_000 : null;
  const blocked = minutesSince != null && minutesSince < ACTIVITY_WINDOW_MIN;
  return {
    checked: true, window_minutes: ACTIVITY_WINDOW_MIN,
    last_activity_at: lastMs ? new Date(lastMs).toISOString() : null,
    minutes_since: minutesSince != null ? Math.round(minutesSince * 10) / 10 : null,
    blocked, reason: blocked ? 'recent auction write — live likely active; writes refused' : 'quiet — safe to write',
  };
}

// Caller must be a member of the store (the app's existing store-access gate). Returns the store's
// connection (owner + creds) via the service role — the store's data owner may not be the caller.
async function authorizeStore(storeId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!storeId) return { error: NextResponse.json({ error: 'store_id required' }, { status: 400 }) };
  const { data: member } = await supabase.from('store_members').select('store_id').eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!member) return { error: NextResponse.json({ error: 'No access to this store' }, { status: 403 }) };
  const admin = createAdminClient();
  const { data: conn } = await admin.from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at').eq('store_id', storeId).maybeSingle();
  return { admin, conn: (conn ?? null) as ConnRow | null, ownerId: conn ? String(conn.user_id) : null };
}

export async function GET(req: Request) {
  const storeId = new URL(req.url).searchParams.get('store_id')?.trim() ?? '';
  const a = await authorizeStore(storeId);
  if (a.error) return a.error;
  const { admin, ownerId } = a;
  if (!ownerId) return NextResponse.json({ error: 'no TikTok connection for store' }, { status: 400 });
  // Coverage over the WHOLE packable set (TARGET_STATUSES) — not just AWAITING_COLLECTION. Orders
  // get labels while still AWAITING_SHIPMENT, and those trackings arrive later, so measuring only
  // AWAITING_COLLECTION reads 100% while thousands of AWAITING_SHIPMENT/ON_HOLD orders sit NULL and
  // fail the label scan. This is the number a packer must see before starting.
  const base = () => admin.from('synced_order_ids').select('order_id', { count: 'exact', head: true })
    .eq('user_id', ownerId).eq('store_id', storeId).in('status', TARGET_STATUSES);
  const { count: total } = await base();
  const { count: withTrk } = await base().not('tracking_number', 'is', null);
  return NextResponse.json({ store_id: storeId, total: total ?? 0, with_tracking: withTrk ?? 0, missing_tracking: (total ?? 0) - (withTrk ?? 0) });
}

type CorrectionProposal = { order_id: string; combine_group_id: string | null; old: string; new: string };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { store_id?: string; dry_run?: boolean; correct?: boolean; after?: string };
  const storeId = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const dryRun = body.dry_run !== false;  // default TRUE
  const doCorrect = body.correct !== false; // default TRUE (include the stale-overwrite path)
  const after = typeof body.after === 'string' ? body.after : '';

  const a = await authorizeStore(storeId);
  if (a.error) return a.error;
  const { admin, conn, ownerId } = a;
  if (!conn || !ownerId) return NextResponse.json({ error: 'no TikTok connection for store' }, { status: 400 });

  // Write-gate readout — INFORMATIONAL ONLY (no longer enforced). The 409 refusal was cargo-culted
  // from PR #74: this route writes synced_order_ids.tracking_number, a table DISJOINT from the
  // auction path (capture_events / live_auction_items), so there is no write contention to gate
  // against. Refusing writes during a live only blocked the normal case — syncing the previous
  // show's labels while the next one runs. Kept in the response for observability; enforcement gone.
  const writeGate = await writeGateStatus(admin);

  const started = Date.now();
  let token = '', cipher = '', tokenLoaded = false;
  let calls = 0, examined = 0, filled = 0, corrected = 0, unchanged = 0, noLabel = 0, notReturned = 0, budgetExhausted = false;
  const proposedFills: string[] = [];              // order_ids that would receive a first tracking (dry-run)
  const proposedCorrections: CorrectionProposal[] = []; // stored→live overwrites (dry-run OR executed)
  let cursor = after;

  outer: while (true) {
    if (calls >= CALL_BUDGET || Date.now() - started >= TIME_BUDGET_MS) { budgetExhausted = true; break; }
    // Keyset page of ACTIVE-status target orders (order_id lexicographic), store-scoped. Unlike the
    // old fill-only route this pulls BOTH null and non-null tracking rows, because a non-null value
    // may be STALE and need correcting — we can't know without comparing to live. Carry the stored
    // tracking + combine group so the loop can classify fill vs correct vs unchanged.
    const { data: page, error } = await admin.from('synced_order_ids')
      .select('order_id, tracking_number, auto_combine_group_id')
      .eq('user_id', ownerId).eq('store_id', storeId).in('status', TARGET_STATUSES)
      .gt('order_id', cursor).order('order_id', { ascending: true }).limit(1000);
    if (error) return NextResponse.json({ error: `read failed: ${error.message}` }, { status: 500 });
    if (!page?.length) break;

    if (!tokenLoaded) {
      const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
      token = fresh.accessToken as string; cipher = (fresh.shopCipher ?? conn.shop_cipher) as string; tokenLoaded = true;
    }

    const stored = new Map<string, { trk: string | null; grp: string | null }>();
    for (const r of page) stored.set(String(r.order_id), { trk: (r.tracking_number as string | null) ?? null, grp: (r.auto_combine_group_id as string | null) ?? null });
    const ids = [...stored.keys()];

    for (let i = 0; i < ids.length; i += 50) {
      if (calls >= CALL_BUDGET || Date.now() - started >= TIME_BUDGET_MS) { budgetExhausted = true; break outer; }
      const chunk = ids.slice(i, i + 50);
      let got: Record<string, unknown>[] = [];
      for (let attempt = 0; ; attempt++) {
        try { got = await getOrderById(token, cipher, chunk); break; }
        catch (e) {
          const msg = String(e);
          // Self-limit under load: on a rate-limit, back off and retry (up to MAX_429_RETRIES)
          // rather than failing the whole sweep. Any other error — or a 429 past the retries —
          // still surfaces as 502. Mirrors refresh-status's net; makes the route safe mid-live.
          if (/429|rate|too many/i.test(msg) && attempt < MAX_429_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
          return NextResponse.json({ error: 'getOrderById failed', detail: msg }, { status: 502 });
        }
      }
      calls++;
      const returned = new Set<string>();
      for (const o of got) {
        const id = String(o.id); returned.add(id);
        const trk = o.tracking_number ? String(o.tracking_number).trim() : '';
        if (!trk) { noLabel++; continue; }               // API returned the order but no label yet — NEVER write.
        const s = stored.get(id);
        const oldTrk = s?.trk ?? null;
        if (oldTrk === trk) { unchanged++; continue; }    // already correct.

        if (oldTrk === null) {
          // FILL: no stored tracking. Non-destructive. COALESCE-safe write (is-null guard).
          if (dryRun) { filled++; proposedFills.push(id); continue; }
          const { count } = await admin.from('synced_order_ids')
            .update({ tracking_number: trk }, { count: 'exact' })
            .eq('store_id', storeId).eq('order_id', id).is('tracking_number', null);
          filled += count ?? 0;
          continue;
        }

        // CORRECT: stored non-null but DIFFERENT from live → overwrite (authoritative-wins).
        if (!doCorrect) { unchanged++; continue; }        // fill-only mode: leave stale values as-is.
        proposedCorrections.push({ order_id: id, combine_group_id: s?.grp ?? null, old: oldTrk, new: trk });
        if (dryRun) { corrected++; continue; }
        // WRITE: overwrite guarded on the EXACT stale value (so a concurrent change can't be clobbered).
        const { count } = await admin.from('synced_order_ids')
          .update({ tracking_number: trk }, { count: 'exact' })
          .eq('store_id', storeId).eq('order_id', id).eq('tracking_number', oldTrk);
        if ((count ?? 0) > 0) {
          corrected += count ?? 0;
          // AUDIT: log the overwrite so the sweep is traceable and reversible (old_tracking restores it).
          await admin.from('tracking_correction_log').insert({
            user_id: ownerId, store_id: storeId, order_id: id,
            old_tracking: oldTrk, new_tracking: trk, combine_group_id: s?.grp ?? null, source: 'sync-tracking',
          });
        }
      }
      examined += chunk.length;
      notReturned += chunk.filter((id) => !returned.has(id)).length;
      cursor = chunk[chunk.length - 1];
      await sleep(60);
    }
    if (page.length < 1000) break;
  }

  // Candidate orders still ahead of the cursor (drives the UI's resume loop). Counts the ACTIVE
  // set now (not just nulls), since a full sweep must examine every active order to catch stale ones.
  const { count: remaining } = await admin.from('synced_order_ids')
    .select('order_id', { count: 'exact', head: true })
    .eq('user_id', ownerId).eq('store_id', storeId).in('status', TARGET_STATUSES)
    .gt('order_id', cursor || '');

  // Corrections grouped by combine group, stored→live, with counts (the re-label view the operator wants).
  const byGroup: Record<string, { count: number; changes: Array<{ order_id: string; old: string; new: string }> }> = {};
  for (const c of proposedCorrections) {
    const k = c.combine_group_id ?? '(none)';
    (byGroup[k] ??= { count: 0, changes: [] });
    byGroup[k].count++;
    byGroup[k].changes.push({ order_id: c.order_id, old: c.old, new: c.new });
  }

  return NextResponse.json({
    dry_run: dryRun, correct: doCorrect, store_id: storeId,
    write_gate: writeGate,
    examined, filled, corrected, unchanged, no_label: noLabel, not_returned: notReturned,
    remaining: remaining ?? 0, next_after: (remaining ?? 0) > 0 ? cursor : null,
    done: (remaining ?? 0) === 0,
    corrections_by_group: byGroup,
    corrections_group_count: Object.keys(byGroup).length,
    proposed_fill_count: dryRun ? proposedFills.length : undefined,
    note: dryRun
      ? 'DRY RUN — nothing written. `filled`=would fill NULLs, `corrected`=would overwrite STALE (see corrections_by_group).'
      : 'Writes applied: NULLs filled (COALESCE-safe) + STALE overwritten (logged to tracking_correction_log, reversible via old_tracking).',
    budget: { calls, ms_used: Date.now() - started, exhausted: budgetExhausted },
  });
}
