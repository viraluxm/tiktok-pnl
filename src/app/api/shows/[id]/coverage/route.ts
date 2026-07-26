import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET: post-live ORDER COVERAGE CHECK — read-only, LIST ONLY. Surfaces the set
// reconcile/refresh-payouts can't see: TikTok orders that SYNCED but were never
// captured by the extension (and so were never bound). See REVIEW.md §1.3.
//
// Definitions (all three counts are over the SAME synced-order universe):
//   Authoritative list = synced_order_ids for the show's window/store.
//   Captured           = has a capture_events row (order_id).
//   Bound              = has a live_auction_items row (client_idempotency_key = order_id).
//   COVERAGE GAP       = synced AND neither captured NOR bound.   ← the invisible set
//   captured_but_unbound = synced AND captured AND NOT bound  (reconcile already
//                          handles these; reported separately, never conflated).
//
// Scoping mirrors the existing show endpoints (reconcile/duration): the session's
// own store_id + its active window. NOTE ON GRANULARITY: synced_order_ids stores
// only order_date (a DATE), not an order timestamp, so the window is applied at
// DATE granularity in the shop timezone — the same field/timezone the sync writer
// uses. A store with non-live orders on the show's date(s) will see them here too;
// this is a list-only signal, not an authoritative "these are live orders" claim.
//
// No writes. No binding. No inventory changes.

const SHOP_TIMEZONE = 'America/Los_Angeles'; // matches src/app/api/tiktok/sync/route.ts

// YYYY-MM-DD in the shop timezone (same format the sync writer stores order_date in).
function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}

// Cancelled-family filter — same predicate as src/app/api/tiktok/product-stats/route.ts:54.
// NULL / paid statuses are kept; only cancellations are dropped.
function isCancelled(status: string | null | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return s === 'CANCELLED' || s.includes('CANCEL');
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = user.id;

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, started_at, ended_at, store_id, created_at, tiktok_live_id')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const startIso: string | null = session.started_at ?? session.created_at ?? null;
  if (!startIso) {
    // No usable start → nothing to window against (a draft never started).
    return NextResponse.json({
      total_synced: 0,
      captured_but_unbound_count: 0, captured_but_unbound_ids: [],
      coverage_gap_count: 0, coverage_gap: [],
      window: { start_date: null, end_date: null, store_id: session.store_id ?? null },
    });
  }

  // Window end — mirror the duration endpoint: prefer a SANE ended_at, else the
  // last capture in the window, else the start (guards a show that reads "Live"
  // days later). Only the resulting DATE is used to bound order_date.
  let capQ = supabase
    .from('capture_events')
    .select('created_at')
    .eq('user_id', user.id)
    .gte('created_at', startIso)
    .order('created_at', { ascending: false })
    .limit(1);
  if (session.ended_at) capQ = capQ.lte('created_at', session.ended_at);
  const { data: lastCap } = await capQ;
  const lastCaptureIso: string | null = lastCap?.[0]?.created_at ?? null;

  let endIso = lastCaptureIso ?? startIso;
  if (session.ended_at) {
    const s = new Date(startIso).getTime();
    const e = new Date(session.ended_at).getTime();
    const lc = lastCaptureIso ? new Date(lastCaptureIso).getTime() : null;
    const sane = e > s && (lc == null || e <= lc + 6 * 3600 * 1000);
    if (sane) endIso = session.ended_at;
  }

  const startDate = localDate(startIso);
  const endDate = localDate(endIso);

  // ── Authoritative order list: synced_order_ids in [startDate, endDate] for the
  //    show's store (store-scoped only when the session has a store_id; else the
  //    account's orders for those dates). Page to avoid the 1000-row cap silently
  //    truncating a busy day.
  interface SyncedRow {
    order_id: string;
    order_date: string | null;
    order_created_at: string | null;
    created_at: string | null;
    gmv: number | string | null;
    status: string | null;
    auto_combine_group_id: string | null;
  }
  // The DB query windows on order_date (a DATE) — a correct SUPERSET of the precise
  // timestamp window: any order whose order_created_at ∈ [startIso, endIso] has an
  // order_date ∈ [startDate, endDate] by construction. We then refine in JS using
  // the exact timestamp when it's present (migration 051). This keeps the query
  // working unchanged on un-backfilled rows (order_created_at NULL → date fallback).
  const syncedRows: SyncedRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('synced_order_ids')
      .select('order_id, order_date, order_created_at, created_at, gmv, status, auto_combine_group_id')
      .eq('user_id', user.id)
      .gte('order_date', startDate)
      .lte('order_date', endDate)
      .order('order_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (session.store_id) q = q.eq('store_id', session.store_id);
    const { data, error } = await q;
    if (error) {
      console.error('[shows/coverage] synced_order_ids error:', error.message);
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
    }
    syncedRows.push(...((data ?? []) as SyncedRow[]));
    if (!data || data.length < PAGE) break;
  }

  // Precise timestamp window bounds for the JS refinement below.
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  // Exclude junk order_id "0" (pack-station doesn't, but reconcile/payouts do —
  // this endpoint MUST) and cancelled orders. Then refine to the PRECISE live
  // window using order_created_at when present; rows without it (pre-backfill)
  // keep the date-granularity behavior (already bounded by the query). (user_id,
  // order_id) is unique, so no in-set dedup is needed.
  let timestampScopedRows = 0; // refined by real order_created_at
  let dateFallbackRows = 0;    // still on order_date (order_created_at NULL)
  const scoped = syncedRows.filter((r) => {
    if (!r.order_id || r.order_id === '0' || isCancelled(r.status)) return false;
    if (r.order_created_at) {
      const t = new Date(r.order_created_at).getTime();
      if (Number.isFinite(t)) {
        if (t < startMs || t > endMs) return false; // outside the precise live window
        timestampScopedRows += 1;
        return true;
      }
    }
    dateFallbackRows += 1; // NULL/unparseable → date-window fallback (kept)
    return true;
  });
  const orderIds = scoped.map((r) => r.order_id);

  // Which of the scoped orders have a capture / a bind. Chunk the .in() lists so a
  // long day never blows the query-string limit.
  async function presentIds(table: string, col: string): Promise<Set<string>> {
    const present = new Set<string>();
    const CH = 300;
    for (let i = 0; i < orderIds.length; i += CH) {
      const chunk = orderIds.slice(i, i + CH);
      const { data, error } = await supabase
        .from(table)
        .select(col)
        .eq('user_id', userId)
        .in(col, chunk);
      if (error) {
        console.error(`[shows/coverage] ${table} lookup error:`, error.message);
        continue; // partial data is safer than a hard fail on a read-only check
      }
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const v = row[col];
        if (v != null) present.add(String(v));
      }
    }
    return present;
  }

  const boundSet = orderIds.length ? await presentIds('live_auction_items', 'client_idempotency_key') : new Set<string>();

  // ── ROOM-RESPECTING capture attribution. capture_events.room_id (= a session's
  //    tiktok_live_id) is the ONLY reliable attribution under concurrent same-store lives, so a
  //    captured order is "captured FOR THIS SHOW" only when a (successful) capture carries THIS
  //    session's room. This matches the board table exactly and removes the phantom cross-listing
  //    that room-agnostic scoping produced across concurrent shows.
  //      never captured  → no capture row at all (coverage gap; the reconcile-blind set)
  //      captured-but-unbound → captured under THIS room, not bound (the actionable table set)
  //      room unknown    → captured only under a NULL / orphan room (matches no session) — cannot
  //                        attribute to any show; surfaced separately so it never silently vanishes
  //                        (the strict room filter means it appears on no board)
  //      (captured under a SIBLING session's room → belongs to that show; excluded here)
  const thisRoom = (session.tiktok_live_id as string | null) ?? null;
  const knownRooms = new Set<string>();
  {
    const { data: rs } = await supabase.from('live_sessions')
      .select('tiktok_live_id').eq('user_id', userId).not('tiktok_live_id', 'is', null);
    for (const r of rs ?? []) if (r.tiktok_live_id) knownRooms.add(String(r.tiktok_live_id));
  }
  // Per scoped order: whether it has ANY capture, and the rooms of its SUCCESSFUL captures.
  const anyCapture = new Set<string>();
  const okRoomsByOrder = new Map<string, Set<string | null>>();
  {
    const CH = 300;
    for (let i = 0; i < orderIds.length; i += CH) {
      const chunk = orderIds.slice(i, i + CH);
      const { data, error } = await supabase.from('capture_events')
        .select('order_id, room_id, is_payment_successful').eq('user_id', userId).in('order_id', chunk);
      if (error) { console.error('[shows/coverage] capture-room lookup error:', error.message); continue; }
      for (const c of (data ?? []) as { order_id: string; room_id: string | null; is_payment_successful: boolean | null }[]) {
        const oid = String(c.order_id);
        anyCapture.add(oid);
        if (c.is_payment_successful === false) continue; // failed payment ≠ a bindable sale
        if (!okRoomsByOrder.has(oid)) okRoomsByOrder.set(oid, new Set());
        okRoomsByOrder.get(oid)!.add(c.room_id ?? null);
      }
    }
  }
  // never | thisRoom | otherKnown | orphan | failed(captured but no successful capture)
  const classify = (oid: string): 'never' | 'thisRoom' | 'otherKnown' | 'orphan' | 'failed' => {
    if (!anyCapture.has(oid)) return 'never';
    const rooms = okRoomsByOrder.get(oid);
    if (!rooms || rooms.size === 0) return 'failed';
    if (thisRoom && rooms.has(thisRoom)) return 'thisRoom';
    for (const r of rooms) if (r && r !== thisRoom && knownRooms.has(r)) return 'otherKnown';
    return 'orphan'; // successful captures, but only under NULL/orphan rooms → cannot attribute
  };

  interface GapRow {
    order_id: string; order_date: string | null; created_at: string | null; buyer: string | null;
    gmv: number | null; status: string | null; auto_combine_group_id: string | null;
  }
  const gapRow = (r: typeof scoped[number]): GapRow => ({
    order_id: r.order_id, order_date: r.order_date, created_at: r.created_at, buyer: null,
    gmv: r.gmv == null ? null : Number(r.gmv), status: r.status, auto_combine_group_id: r.auto_combine_group_id,
  });

  const capturedButUnboundIds: string[] = [];
  const coverageGap: GapRow[] = [];
  const roomUnknown: GapRow[] = [];
  for (const r of scoped) {
    if (boundSet.has(r.order_id)) continue; // bound (any session) → not actionable here
    switch (classify(r.order_id)) {
      case 'never': coverageGap.push(gapRow(r)); break;
      case 'thisRoom': capturedButUnboundIds.push(r.order_id); break;
      case 'orphan': roomUnknown.push(gapRow(r)); break;
      // 'otherKnown' (sibling live's sale) and 'failed' (payment failed) are intentionally not surfaced here
    }
  }

  return NextResponse.json({
    total_synced: scoped.length,
    captured_but_unbound_count: capturedButUnboundIds.length,
    captured_but_unbound_ids: capturedButUnboundIds,
    coverage_gap_count: coverageGap.length,
    coverage_gap: coverageGap,
    // Captured but attributable to NO show (null/orphan room). Not bindable on any board — shown
    // as its own labeled group so it never silently disappears.
    room_unknown_count: roomUnknown.length,
    room_unknown: roomUnknown,
    window: {
      start_date: startDate,
      end_date: endDate,
      start_at: startIso,
      end_at: endIso,
      store_id: session.store_id ?? null,
      // Scoping transparency: how many scoped rows used the precise timestamp vs
      // fell back to date granularity (pre-backfill rows with a NULL order_created_at).
      timestamp_scoped_rows: timestampScopedRows,
      date_fallback_rows: dateFallbackRows,
    },
  });
}
