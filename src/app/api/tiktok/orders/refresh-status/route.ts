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
// RUN that reports the transition table and writes nothing. Mirrors backfill-tracking's write
// discipline: targeted UPDATE of a SINGLE column (status), guarded by store_id+order_id. It
// NEVER uses parseOrder/upsert and NEVER touches tracking_number or auto_combine_group_id (the
// bind/pick path depends on both), nor gmv/sku_*/units.
//
// STATELESS + RESUMABLE: target = rows WHERE status IN (open set), keyset-paged by order_id
// (a stable lexicographic total order). Each invocation is bounded by a call/time budget and
// returns { examined, updated, remaining, next_after } so a caller re-invokes until remaining
// is 0. The set self-shrinks as orders go terminal, so partial passes are safe. No migration.
//
// WRITE GATE: writes are refused while a live is active (recent capture_events / live_auction_items
// write within ACTIVITY_WINDOW_MIN) — NOT gated on live_sessions.status (orphaned 'live' rows
// make it unreliable). The gate is reported on every call and enforced only in write mode.

const CORE_OPEN = ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'ON_HOLD', 'PARTIALLY_SHIPPING'];
const OPT_IN = ['IN_TRANSIT', 'UNPAID']; // only when include_in_transit_unpaid:true
// Terminal — never targeted: DELIVERED, COMPLETED, CANCELLED. (order_status is a fulfillment
// lifecycle with no RETURNED/REFUNDED state; post-COMPLETED returns live in return_refund objects
// and never flip order_status — so COMPLETED is safe to skip forever.)

const ACTIVITY_WINDOW_MIN = 15;   // no auction write within this window ⇒ safe to write
const CHUNK = 50;                  // getOrderById max ids/call
// Per-invocation defaults DERIVED from the measured per-call latency (Q3, real 78-call sample):
// a 50-id call runs mean ~890ms / p90 ~1.1s / max ~1.68s. With ~80ms pacing that's ~1.0s/call, so
// under a 240s time budget ~200 calls fit with margin below maxDuration=300s. A cold full sweep is
// ~240 calls (~12k open / 50) ⇒ ~2 invocations; re-invoke with `after` until remaining_total=0.
// Both bounds apply; whichever trips first ends the invocation (time budget is the hard stop).
const DEFAULT_TIME_BUDGET_MS = 240_000;  // 4 min, leaves margin under the 300s ceiling
const DEFAULT_CALL_BUDGET = 200;         // ~200 calls × ~1.0s ≈ 200s < time budget
const MAX_429_RETRIES = 3;

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
  const perStore: Record<string, { store_id: string; examined: number; calls: number; changed: number; updated: number; not_returned: number; remaining: number; next_after: string | null }> = {};
  const totals = { examined: 0, calls: 0, changed: 0, updated: 0, not_returned: 0, remaining: 0 };
  const nextAfter: Record<string, string> = {};
  let callsUsed = 0;
  let budgetExhausted = false;

  for (const c of conns) {
    const storeId = String(c.store_id);
    const ownerUserId = String(c.user_id);
    const storeName = storeNames.get(storeId) || storeId;
    const ps = { store_id: storeId, examined: 0, calls: 0, changed: 0, updated: 0, not_returned: 0, remaining: 0, next_after: null as string | null };
    perStore[storeName] = ps;

    let cursor = afterIn[storeId] ?? '';
    let token = ''; let cipher = String(c.shop_cipher);
    let tokenLoaded = false;

    // Keyset-page the target set (order_id lexicographic) so resumption is stable under writes.
    outer: while (true) {
      if (callsUsed >= callBudget || Date.now() - started >= timeBudgetMs) { budgetExhausted = true; break; }

      const { data: page, error: pErr } = await admin.from('synced_order_ids')
        .select('order_id, status')
        .eq('user_id', ownerUserId).eq('store_id', storeId)
        .in('status', statuses)
        .gt('order_id', cursor)
        .order('order_id', { ascending: true })
        .limit(1000);
      if (pErr) return NextResponse.json({ error: `synced read failed: ${pErr.message}` }, { status: 500 });
      if (!page?.length) { ps.next_after = cursor || null; break; }

      const storedById = new Map(page.map((r) => [String(r.order_id), String(r.status)]));
      const ids = [...storedById.keys()];

      if (!tokenLoaded) {
        const fresh = await getFreshToken(admin, c as unknown as ConnRow, { skewMinutes: 30 });
        token = fresh.accessToken as string; cipher = fresh.shopCipher as string; tokenLoaded = true;
      }

      for (let i = 0; i < ids.length; i += CHUNK) {
        if (callsUsed >= callBudget || Date.now() - started >= timeBudgetMs) { budgetExhausted = true; ps.next_after = cursor || null; break outer; }
        const chunk = ids.slice(i, i + CHUNK);

        // getOrderById with 429 backoff.
        let got: Record<string, unknown>[] = [];
        for (let attempt = 0; ; attempt++) {
          try { got = await getOrderById(token, cipher, chunk); break; }
          catch (e) {
            const msg = String(e);
            if (/429|rate|too many/i.test(msg) && attempt < MAX_429_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
            return NextResponse.json({ error: 'getOrderById failed', detail: msg, store_id: storeId }, { status: 502 });
          }
        }
        callsUsed++; ps.calls++;

        const returned = new Set<string>();
        for (const o of got) {
          const id = String(o.id); returned.add(id);
          const from = storedById.get(id); if (from === undefined) continue;
          const to = String(o.status || '').toUpperCase();
          if (!to) continue; // never infer from an empty status
          const key = `${from} -> ${to}`;
          transitions[key] = (transitions[key] || 0) + 1;
          if (to !== from) {
            ps.changed++;
            if (sample.length < sampleN) sample.push({ store: storeName, order_id: id, from, to });
            if (write) {
              // status ONLY. .neq guards against a no-op / concurrent-sync race. Never touches
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
        await sleep(80); // gentle pacing
      }

      cursor = ids[ids.length - 1];
      ps.next_after = cursor;
      if (page.length < 1000) break; // store's target set exhausted this sweep
    }

    // Remaining target rows still ahead of this store's cursor.
    const { count: rem } = await admin.from('synced_order_ids')
      .select('order_id', { count: 'exact', head: true })
      .eq('user_id', ownerUserId).eq('store_id', storeId).in('status', statuses)
      .gt('order_id', ps.next_after ?? '');
    ps.remaining = rem ?? 0;
    if (ps.next_after) nextAfter[storeId] = ps.next_after;

    totals.examined += ps.examined; totals.calls += ps.calls; totals.changed += ps.changed;
    totals.updated += ps.updated; totals.not_returned += ps.not_returned; totals.remaining += ps.remaining;
  }

  return NextResponse.json({
    mode: write ? 'write' : 'dry_run',
    dry_run: !write,
    target_statuses: statuses,
    store_filter: storeFilter || 'ALL',
    write_gate: writeGate,
    stores: perStore,
    totals,
    transitions,
    sample,
    budget: {
      call_budget: callBudget, time_budget_ms: timeBudgetMs,
      calls_used: callsUsed, ms_used: Date.now() - started, exhausted: budgetExhausted,
    },
    // Pass this back as `after` to resume; empty ⇒ every store's target set is fully swept.
    next_after: nextAfter,
    remaining_total: totals.remaining,
    note: write
      ? 'WRITE pass. Re-invoke with the returned `after` until remaining_total is 0.'
      : 'DRY RUN — no rows written. Review transitions; re-invoke with mode:"write" (gated) to apply.',
  });
}
