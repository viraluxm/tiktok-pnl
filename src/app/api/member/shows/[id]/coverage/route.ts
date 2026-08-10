import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { resolveOwnedSession } from '@/lib/member/shows';

export const dynamic = 'force-dynamic';

// Owner-scoped, READ-ONLY mirror of /api/shows/[id]/coverage for the member 'shows' scope. Surfaces
// the post-live order-coverage gap (synced-but-never-captured) + captured-but-unbound + room-unknown.
// No cost/margin anywhere (gmv is order revenue). Session ownership + store verified (403) up front.
const SHOP_TIMEZONE = 'America/Los_Angeles';

function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}
function isCancelled(status: string | null | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return s === 'CANCELLED' || s.includes('CANCEL');
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireMemberScope('shows');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const owned = await resolveOwnedSession(admin, id, { ownerIds, storeIds, allStores },
    'user_id, store_id, id, started_at, ended_at, created_at, tiktok_live_id');
  if (!owned.ok) return owned.response;
  const { session, ownerUserId } = owned;
  const sessionStoreId = (session.store_id as string | null) ?? null;

  const startIso: string | null = (session.started_at as string | null) ?? (session.created_at as string | null) ?? null;
  if (!startIso) {
    return NextResponse.json({
      total_synced: 0,
      captured_but_unbound_count: 0, captured_but_unbound_ids: [],
      coverage_gap_count: 0, coverage_gap: [],
      window: { start_date: null, end_date: null, store_id: sessionStoreId },
    });
  }

  // Window end — prefer a sane ended_at, else last capture, else start.
  let capQ = admin
    .from('capture_events')
    .select('created_at')
    .eq('user_id', ownerUserId)
    .gte('created_at', startIso)
    .order('created_at', { ascending: false })
    .limit(1);
  const endedAt = session.ended_at as string | null;
  if (endedAt) capQ = capQ.lte('created_at', endedAt);
  const { data: lastCap } = await capQ;
  const lastCaptureIso: string | null = lastCap?.[0]?.created_at ?? null;

  let endIso = lastCaptureIso ?? startIso;
  if (endedAt) {
    const s = new Date(startIso).getTime();
    const e = new Date(endedAt).getTime();
    const lc = lastCaptureIso ? new Date(lastCaptureIso).getTime() : null;
    const sane = e > s && (lc == null || e <= lc + 6 * 3600 * 1000);
    if (sane) endIso = endedAt;
  }

  const startDate = localDate(startIso);
  const endDate = localDate(endIso);

  interface SyncedRow {
    order_id: string; order_date: string | null; order_created_at: string | null; created_at: string | null;
    gmv: number | string | null; sku_name: string | null; status: string | null; auto_combine_group_id: string | null;
  }
  const syncedRows: SyncedRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin
      .from('synced_order_ids')
      .select('order_id, order_date, order_created_at, created_at, gmv, sku_name, status, auto_combine_group_id')
      .eq('user_id', ownerUserId)
      .gte('order_date', startDate)
      .lte('order_date', endDate)
      .order('order_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (sessionStoreId) q = q.eq('store_id', sessionStoreId);
    const { data, error } = await q;
    if (error) {
      console.error('[member/shows/coverage] synced_order_ids error:', error.message);
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
    }
    syncedRows.push(...((data ?? []) as SyncedRow[]));
    if (!data || data.length < PAGE) break;
  }

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  let timestampScopedRows = 0;
  let dateFallbackRows = 0;
  const scoped = syncedRows.filter((r) => {
    if (!r.order_id || r.order_id === '0' || isCancelled(r.status)) return false;
    if (r.order_created_at) {
      const t = new Date(r.order_created_at).getTime();
      if (Number.isFinite(t)) {
        if (t < startMs || t > endMs) return false;
        timestampScopedRows += 1;
        return true;
      }
    }
    dateFallbackRows += 1;
    return true;
  });
  const orderIds = scoped.map((r) => r.order_id);

  async function presentIds(table: string, col: string): Promise<Set<string>> {
    const present = new Set<string>();
    const CH = 300;
    for (let i = 0; i < orderIds.length; i += CH) {
      const chunk = orderIds.slice(i, i + CH);
      const { data, error } = await admin.from(table).select(col).eq('user_id', ownerUserId).in(col, chunk);
      if (error) { console.error(`[member/shows/coverage] ${table} lookup error:`, error.message); continue; }
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const v = row[col];
        if (v != null) present.add(String(v));
      }
    }
    return present;
  }

  const boundSet = orderIds.length ? await presentIds('live_auction_items', 'client_idempotency_key') : new Set<string>();

  const thisRoom = (session.tiktok_live_id as string | null) ?? null;
  const knownRooms = new Set<string>();
  {
    const { data: rs } = await admin.from('live_sessions')
      .select('tiktok_live_id').eq('user_id', ownerUserId).not('tiktok_live_id', 'is', null);
    for (const r of rs ?? []) if (r.tiktok_live_id) knownRooms.add(String(r.tiktok_live_id));
  }
  const anyCapture = new Set<string>();
  const okRoomsByOrder = new Map<string, Set<string | null>>();
  {
    const CH = 300;
    for (let i = 0; i < orderIds.length; i += CH) {
      const chunk = orderIds.slice(i, i + CH);
      const { data, error } = await admin.from('capture_events')
        .select('order_id, room_id, is_payment_successful').eq('user_id', ownerUserId).in('order_id', chunk);
      if (error) { console.error('[member/shows/coverage] capture-room lookup error:', error.message); continue; }
      for (const c of (data ?? []) as { order_id: string; room_id: string | null; is_payment_successful: boolean | null }[]) {
        const oid = String(c.order_id);
        anyCapture.add(oid);
        if (c.is_payment_successful === false) continue;
        if (!okRoomsByOrder.has(oid)) okRoomsByOrder.set(oid, new Set());
        okRoomsByOrder.get(oid)!.add(c.room_id ?? null);
      }
    }
  }
  const classify = (oid: string): 'never' | 'thisRoom' | 'otherKnown' | 'orphan' | 'failed' => {
    if (!anyCapture.has(oid)) return 'never';
    const rooms = okRoomsByOrder.get(oid);
    if (!rooms || rooms.size === 0) return 'failed';
    if (thisRoom && rooms.has(thisRoom)) return 'thisRoom';
    for (const r of rooms) if (r && r !== thisRoom && knownRooms.has(r)) return 'otherKnown';
    return 'orphan';
  };

  const skuByNumber = new Set<number>();
  {
    const { data: inv } = await admin.from('inventory_skus').select('sku_number').eq('user_id', ownerUserId);
    for (const s of inv ?? []) if (s.sku_number != null) skuByNumber.add(Number(s.sku_number));
  }
  const isMissedAuction = (name: string | null): boolean => {
    if (!name || !/^[0-9]+$/.test(name.trim())) return false;
    const n = Number(name.trim());
    return Number.isFinite(n) && skuByNumber.has(n);
  };

  interface GapRow {
    order_id: string; order_date: string | null; created_at: string | null; buyer: string | null;
    gmv: number | null; status: string | null; auto_combine_group_id: string | null; sku_name: string | null;
  }
  const gapRow = (r: typeof scoped[number]): GapRow => ({
    order_id: r.order_id, order_date: r.order_date, created_at: r.created_at, buyer: null,
    gmv: r.gmv == null ? null : Number(r.gmv), status: r.status, auto_combine_group_id: r.auto_combine_group_id,
    sku_name: r.sku_name ?? null,
  });

  const capturedButUnboundIds: string[] = [];
  const missedCapture: GapRow[] = [];
  const catalogSales: GapRow[] = [];
  const roomUnknown: GapRow[] = [];
  for (const r of scoped) {
    if (boundSet.has(r.order_id)) continue;
    switch (classify(r.order_id)) {
      case 'never': (isMissedAuction(r.sku_name) ? missedCapture : catalogSales).push(gapRow(r)); break;
      case 'thisRoom': capturedButUnboundIds.push(r.order_id); break;
      case 'orphan': roomUnknown.push(gapRow(r)); break;
    }
  }

  return NextResponse.json({
    total_synced: scoped.length,
    captured_but_unbound_count: capturedButUnboundIds.length,
    captured_but_unbound_ids: capturedButUnboundIds,
    missed_capture_count: missedCapture.length,
    missed_capture: missedCapture,
    catalog_count: catalogSales.length,
    catalog: catalogSales,
    coverage_gap_count: missedCapture.length + catalogSales.length,
    coverage_gap: [...missedCapture, ...catalogSales],
    room_unknown_count: roomUnknown.length,
    room_unknown: roomUnknown,
    window: {
      start_date: startDate, end_date: endDate, start_at: startIso, end_at: endIso, store_id: sessionStoreId,
      timestamp_scoped_rows: timestampScopedRows, date_fallback_rows: dateFallbackRows,
    },
  });
}
