import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST: STATUS REFRESH PASS over OPEN orders (Approach 2 — batch getOrderById).
//
// Why: order status in synced_order_ids is a create-day snapshot. The sync bounds on
// create_time_ge/lt with a per-day cursor that never revisits a past day, so an order that
// shipped after its create-day was last synced stays frozen (e.g. ~2k rows stuck in
// AWAITING_COLLECTION for 7+ days). This pass re-pulls the CURRENT status for open orders via
// the order-DETAIL endpoint (GET /order/202309/orders?ids=..., <=50 ids/call) — a direct id
// lookup, so TikTok's broken search cursor is structurally absent — and corrects status ONLY.
//
// MODE (required to write): mode:'write' performs the UPDATE; anything else (default) is a DRY
// RUN that reports the transition table and writes nothing. Write discipline mirrors
// backfill-tracking: targeted UPDATE of a SINGLE column (status), guarded by store_id+order_id.
// It NEVER uses parseOrder/upsert and NEVER touches tracking_number or auto_combine_group_id
// (the bind/pick path depends on both), nor gmv/sku_*/units.
//
// ORDER: OLDEST-OPEN-FIRST (order_created_at asc, nulls last). The stale tail is corrected in the
// first invocation. STATELESS + RESUMABLE: each invocation reloads the oldest open ids, processes
// up to a call/time budget, and (in write mode) corrected rows leave the open set — so the next
// invocation naturally advances. Re-invoke until `updated` is 0 (`done`). No cursor, no migration.
//
// WRITE GATE: writes are refused while a live is active (recent capture_events / live_auction_items
// write within ACTIVITY_WINDOW_MIN) — NOT gated on live_sessions.status (orphaned 'live' rows make
// it unreliable). Reported on every call; enforced (409) only in write mode.
//
// CANCELLATIONS: any order this pass moves to CANCELLED is OUTPUT (with a `bound` flag = has a
// reachable live_auction_item_skus row) so downstream inventory reconciliation can be scoped
// separately. This pass does NOT adjust inventory, unbind, or touch live_auction_items.

const CORE_OPEN = ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'ON_HOLD', 'PARTIALLY_SHIPPING'];
// Opt-in (include_in_transit_unpaid:true) — non-terminal states that still advance. DELIVERED is
// here (NOT terminal): a control sample showed DELIVERED → COMPLETED, so leaving it skip-forever
// would refreeze the ~2.4k orders this sweep moves into DELIVERED, recreating the bug one hop down.
const OPT_IN = ['IN_TRANSIT', 'UNPAID', 'DELIVERED'];
// Skip forever — genuinely terminal: COMPLETED, CANCELLED. (order_status is a fulfillment lifecycle
// with no RETURNED/REFUNDED state; post-COMPLETED returns live in return_refund objects and never
// flip order_status — COMPLETED verified terminal by a 500-order control sample: 0/429 changed.)

const ACTIVITY_WINDOW_MIN = 15;   // no auction write within this window ⇒ safe to write
const CHUNK = 50;                 // getOrderById max ids/call
// Per-invocation defaults DERIVED from measured per-call latency (Q3, real 78-call sample): a
// 50-id call runs mean ~890ms / p90 ~1.1s / max ~1.68s. With ~80ms pacing that's ~1.0s/call, so
// under a 240s time budget ~200 calls fit with margin below maxDuration=300s. A cold full sweep is
// ~240 calls (~12k open / 50) ⇒ ~2 invocations; re-invoke until `done`. Both bounds apply; the
// time budget is the hard stop.
const DEFAULT_TIME_BUDGET_MS = 240_000;
const DEFAULT_CALL_BUDGET = 200;
const MAX_429_RETRIES = 3;
const CH_IN = 300; // .in() list chunk for the cancellation bound-lookup

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  let body: {
    mode?: string; store_id?: string; include_in_transit_unpaid?: boolean;
    call_budget?: number; time_budget_ms?: number; sample?: number;
    after?: Record<string, string>;
  };
  try { body = await req.json(); } catch { body = {}; }

  const write = body.mode === 'write';
  const storeFilter = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const statuses = body.include_in_transit_unpaid ? [...CORE_OPEN, ...OPT_IN] : [...CORE_OPEN];
  const callBudget = Math.max(1, Math.trunc(Number(body.call_budget) || DEFAULT_CALL_BUDGET));
  const timeBudgetMs = Math.max(5_000, Math.trunc(Number(body.time_budget_ms) || DEFAULT_TIME_BUDGET_MS));
  const sampleN = Math.min(50, Math.max(1, Math.trunc(Number(body.sample) || 20)));
  // Per-store keyset resume cursors from the prior invocation ({ store_id: cursor }); empty = start.
  const afterIn: Record<string, string> = (body.after && typeof body.after === 'object') ? body.after : {};

  const admin = createAdminClient();
  const started = Date.now();

  // ── Write gate: most-recent auction write across capture_events + live_auction_items ──
  async function latestActivity(table: string): Promise<number | null> {
    const { data } = await admin.from(table).select('created_at').order('created_at', { ascending: false }).limit(1);
    const ts = data?.[0]?.created_at as string | undefined;
    return ts ? new Date(ts).getTime() : null;
  }
  const [capTs, itemTs] = await Promise.all([latestActivity('capture_events'), latestActivity('live_auction_items')]);
  const lastActivityMs = Math.max(capTs ?? 0, itemTs ?? 0) || null;
  const minutesSince = lastActivityMs ? (Date.now() - lastActivityMs) / 60_000 : null;
  const gateBlocked = minutesSince != null && minutesSince < ACTIVITY_WINDOW_MIN;
  const writeGate = {
    checked: true,
    window_minutes: ACTIVITY_WINDOW_MIN,
    last_activity_at: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    minutes_since: minutesSince != null ? Math.round(minutesSince * 10) / 10 : null,
    blocked: gateBlocked,
    reason: gateBlocked ? 'recent auction write — live likely active; writes refused' : 'quiet — safe to write',
  };

  if (write && gateBlocked) {
    return NextResponse.json({
      mode: 'write', aborted: true, write_gate: writeGate,
      note: `Refusing to write: last auction activity ${writeGate.minutes_since}m ago (< ${ACTIVITY_WINDOW_MIN}m). Re-run when quiet.`,
    }, { status: 409 });
  }

  // Connections to process (per-store; each carries its own encrypted creds).
  let connQ = admin.from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at');
  if (storeFilter) connQ = connQ.eq('store_id', storeFilter);
  const { data: conns, error: connErr } = await connQ;
  if (connErr) return NextResponse.json({ error: `connections read failed: ${connErr.message}` }, { status: 500 });
  if (!conns?.length) return NextResponse.json({ error: 'no matching TikTok connection(s)' }, { status: 400 });

  const storeNames = new Map<string, string>();
  { const { data: st } = await admin.from('stores').select('id, name'); for (const s of st ?? []) storeNames.set(String(s.id), String(s.name)); }

  const transitions: Record<string, number> = {};
  const sample: { store: string; order_id: string; from: string; to: string }[] = [];
  const cancelled: { store: string; store_id: string; order_id: string; user_id: string }[] = [];
  const perStore: Record<string, { store_id: string; examined: number; calls: number; changed: number; updated: number; not_returned: number; remaining: number; next_after: string | null }> = {};
  const totals = { examined: 0, calls: 0, changed: 0, updated: 0, not_returned: 0 };
  const nextAfter: Record<string, string> = {};
  let callsUsed = 0;
  let budgetExhausted = false;

  // Keyset cursor over the OLDEST-open-first order (order_created_at asc, order_id asc). Two
  // phases so NULL order_created_at (undateable rows) are still swept, never skipped: phase 'T'
  // walks dated rows, then phase 'N' walks the null tail by order_id. Encoded as a compact string
  // per store so the caller resumes exactly where the last invocation stopped — validated to
  // visit every open row once (no skip, no dupe) and terminate. order_created_at has no '|'.
  type Cursor = { phase: 'T' | 'N'; ts: string | null; id: string | null };
  const decodeCursor = (s: string | undefined): Cursor => {
    if (!s) return { phase: 'T', ts: null, id: null };
    const p = s.split('|');
    // Use `|| null` (not `?? null`): an unadvanced store re-encodes its null-start as 'T||' /
    // 'N|', so the round-trip must map the EMPTY segments back to null. `?? null` kept '' and,
    // for phase T, built the filter `order_created_at.gt.` → Postgres 400 (invalid timestamp '')
    // → the whole write pass 500s on the second (chained) invocation.
    if (p[0] === 'N') return { phase: 'N', ts: null, id: p[1] || null };
    if (p[0] === 'T') return { phase: 'T', ts: p[1] || null, id: p[2] || null };
    return { phase: 'T', ts: null, id: null };
  };
  const encodeCursor = (cur: Cursor): string =>
    cur.phase === 'N' ? `N|${cur.id ?? ''}` : `T|${cur.ts ?? ''}|${cur.id ?? ''}`;

  // Count of open rows still AHEAD of the cursor (unexamined this sweep) — the resumability
  // `remaining`, which decrements to 0 as the sweep completes.
  const remainingAhead = async (userId: string, storeId: string, cur: Cursor): Promise<number> => {
    const base = () => admin.from('synced_order_ids').select('order_id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('store_id', storeId).in('status', statuses);
    if (cur.phase === 'N') {
      const { count } = await base().is('order_created_at', null).gt('order_id', cur.id ?? '');
      return count ?? 0;
    }
    let qt = base().not('order_created_at', 'is', null);
    if (cur.ts !== null) qt = qt.or(`order_created_at.gt.${cur.ts},and(order_created_at.eq.${cur.ts},order_id.gt.${cur.id})`);
    const { count: ct } = await qt;
    const { count: cn } = await base().is('order_created_at', null);
    return (ct ?? 0) + (cn ?? 0);
  };

  // Split the call budget across stores so a later store isn't starved to zero every pass
  // (processing is sequential per conn; without this, the first store consumed the whole
  // budget and the second always returned its null-start cursor, never progressing). Each
  // store gets a fair share; the global callBudget still caps the total.
  const perStoreCap = Math.max(1, Math.ceil(callBudget / Math.max(1, conns.length)));

  for (const c of conns) {
    const storeId = String(c.store_id);
    const ownerUserId = String(c.user_id);
    const storeName = storeNames.get(storeId) || storeId;
    const ps = { store_id: storeId, examined: 0, calls: 0, changed: 0, updated: 0, not_returned: 0, remaining: 0, next_after: null as string | null };
    perStore[storeName] = ps;

    const cur = decodeCursor(afterIn[storeId]);
    let storeDone = false;
    let callsThisStore = 0;
    let token = ''; let cipher = ''; let tokenLoaded = false;

    outer: while (true) {
      if (callsUsed >= callBudget || callsThisStore >= perStoreCap || Date.now() - started >= timeBudgetMs) { budgetExhausted = true; break; }

      // Fetch the next keyset page for the current phase.
      let pageRows: { order_id: string; status: string; order_created_at: string | null }[] = [];
      if (cur.phase === 'T') {
        let q = admin.from('synced_order_ids').select('order_id, status, order_created_at')
          .eq('user_id', ownerUserId).eq('store_id', storeId).in('status', statuses)
          .not('order_created_at', 'is', null)
          .order('order_created_at', { ascending: true }).order('order_id', { ascending: true }).limit(1000);
        if (cur.ts !== null) q = q.or(`order_created_at.gt.${cur.ts},and(order_created_at.eq.${cur.ts},order_id.gt.${cur.id})`);
        const { data, error } = await q;
        if (error) return NextResponse.json({ error: `synced read failed: ${error.message}` }, { status: 500 });
        pageRows = (data ?? []) as typeof pageRows;
        if (!pageRows.length) { cur.phase = 'N'; cur.id = ''; cur.ts = null; continue; } // dated tail done → nulls
      } else {
        const { data, error } = await admin.from('synced_order_ids').select('order_id, status, order_created_at')
          .eq('user_id', ownerUserId).eq('store_id', storeId).in('status', statuses)
          .is('order_created_at', null).gt('order_id', cur.id ?? '')
          .order('order_id', { ascending: true }).limit(1000);
        if (error) return NextResponse.json({ error: `synced read failed: ${error.message}` }, { status: 500 });
        pageRows = (data ?? []) as typeof pageRows;
        if (!pageRows.length) { storeDone = true; break; }
      }

      if (!tokenLoaded) {
        const fresh = await getFreshToken(admin, c as unknown as ConnRow, { skewMinutes: 30 });
        token = fresh.accessToken as string; cipher = (fresh.shopCipher ?? c.shop_cipher) as string; tokenLoaded = true;
      }

      for (let i = 0; i < pageRows.length; i += CHUNK) {
        if (callsUsed >= callBudget || callsThisStore >= perStoreCap || Date.now() - started >= timeBudgetMs) { budgetExhausted = true; break outer; }
        const chunkRows = pageRows.slice(i, i + CHUNK);
        const storedById = new Map(chunkRows.map((r) => [String(r.order_id), String(r.status)]));
        const chunk = [...storedById.keys()];

        let got: Record<string, unknown>[] = [];
        for (let attempt = 0; ; attempt++) {
          try { got = await getOrderById(token, cipher, chunk); break; }
          catch (e) {
            const msg = String(e);
            if (/429|rate|too many/i.test(msg) && attempt < MAX_429_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
            return NextResponse.json({ error: 'getOrderById failed', detail: msg, store_id: storeId }, { status: 502 });
          }
        }
        callsUsed++; ps.calls++; callsThisStore++;

        const returned = new Set<string>();
        for (const o of got) {
          const id = String(o.id); returned.add(id);
          const from = storedById.get(id); if (from === undefined) continue;
          const to = String(o.status || '').toUpperCase();
          if (!to) continue; // never infer status from an empty payload
          transitions[`${from} -> ${to}`] = (transitions[`${from} -> ${to}`] || 0) + 1;
          if (to !== from) {
            ps.changed++;
            if (sample.length < sampleN) sample.push({ store: storeName, order_id: id, from, to });
            if (to === 'CANCELLED') cancelled.push({ store: storeName, store_id: storeId, order_id: id, user_id: ownerUserId });
            if (write) {
              // status ONLY. .neq guards a no-op / concurrent-sync race. Never touches
              // tracking_number, auto_combine_group_id, gmv, sku_*, units.
              const { error: uErr, count } = await admin.from('synced_order_ids')
                .update({ status: to }, { count: 'exact' })
                .eq('store_id', storeId).eq('order_id', id).neq('status', to);
              if (uErr) console.error('[refresh-status] update error', id, uErr.message);
              else ps.updated += count ?? 0;
            }
          }
        }
        ps.examined += chunk.length;
        ps.not_returned += chunk.filter((id) => !returned.has(id)).length;
        // Advance the cursor to the LAST row of this chunk — resumption is strictly after it, so a
        // mid-page budget cut never re-processes or skips a row.
        const last = chunkRows[chunkRows.length - 1];
        if (cur.phase === 'T') { cur.ts = String(last.order_created_at); cur.id = String(last.order_id); }
        else { cur.id = String(last.order_id); }
        await sleep(80); // gentle pacing
      }

      if (pageRows.length < 1000) {
        // Current phase exhausted (short page). Move dated → null, or finish the store.
        if (cur.phase === 'T') { cur.phase = 'N'; cur.id = ''; cur.ts = null; continue; }
        storeDone = true; break;
      }
      // Full page: cursor advanced; loop to fetch the next page.
    }

    ps.next_after = storeDone ? null : encodeCursor(cur);
    ps.remaining = storeDone ? 0 : await remainingAhead(ownerUserId, storeId, cur);
    if (ps.next_after) nextAfter[storeId] = ps.next_after;
    totals.examined += ps.examined; totals.calls += ps.calls; totals.changed += ps.changed;
    totals.updated += ps.updated; totals.not_returned += ps.not_returned;
  }

  // ── Resolve bound-ness of cancelled orders (report only — NO inventory/bind changes) ──
  // bound = order_id has a live_auction_items row (client_idempotency_key) that owns >=1
  // live_auction_item_skus row. Chunked .in() to stay under the query-string limit.
  const cancelledIds = cancelled.map((c) => c.order_id);
  const boundOrderIds = new Set<string>();
  if (cancelledIds.length) {
    const itemToOrder = new Map<string, string>();
    for (let i = 0; i < cancelledIds.length; i += CH_IN) {
      const { data } = await admin.from('live_auction_items')
        .select('id, client_idempotency_key').in('client_idempotency_key', cancelledIds.slice(i, i + CH_IN));
      for (const r of data ?? []) itemToOrder.set(String(r.id), String(r.client_idempotency_key));
    }
    const itemIds = [...itemToOrder.keys()];
    for (let i = 0; i < itemIds.length; i += CH_IN) {
      const { data } = await admin.from('live_auction_item_skus')
        .select('auction_item_id').in('auction_item_id', itemIds.slice(i, i + CH_IN));
      for (const r of data ?? []) { const oid = itemToOrder.get(String(r.auction_item_id)); if (oid) boundOrderIds.add(oid); }
    }
  }
  const cancelledOut = cancelled.map((c) => ({ store: c.store, order_id: c.order_id, bound: boundOrderIds.has(c.order_id) }));
  const cancelledSummary = { total: cancelledOut.length, bound: cancelledOut.filter((c) => c.bound).length };

  const remainingTotal = Object.values(perStore).reduce((n, s) => n + s.remaining, 0);
  const done = remainingTotal === 0;
  return NextResponse.json({
    mode: write ? 'write' : 'dry_run',
    dry_run: !write,
    target_statuses: statuses, // PARTIALLY_SHIPPING is in this list & the .in() query — zero rows, not absent
    store_filter: storeFilter || 'ALL',
    write_gate: writeGate,
    stores: perStore,
    totals,
    transitions,
    sample,
    cancelled: cancelledOut,
    cancelled_summary: cancelledSummary,
    budget: {
      call_budget: callBudget, time_budget_ms: timeBudgetMs,
      calls_used: callsUsed, ms_used: Date.now() - started, exhausted: budgetExhausted,
    },
    // Resume the sweep by echoing `after` back on the next call; empty when every store is done.
    next_after: nextAfter,
    remaining_total: remainingTotal,
    done,
    note: write
      ? (done ? 'WRITE pass complete — remaining_total=0.' : 'WRITE pass — re-invoke with the returned `next_after` as `after` until remaining_total=0.')
      : 'DRY RUN — no rows written. Review transitions; re-invoke with mode:"write" (gated) to apply.',
  });
}
