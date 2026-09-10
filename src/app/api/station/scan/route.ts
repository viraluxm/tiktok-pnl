import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { DO_NOT_PACK, resolveBox, assembleBox, refundBlockedOrders } from '@/lib/shipping/scanResolve';
import { REASON_CANCELED } from '@/lib/shipping/refundGuard';

export const dynamic = 'force-dynamic';

// POST /api/station/scan — the warehouse fulfillment station's read-only scan.
//
// Gated on app_metadata.role === 'station'. Uses the service role for data
// access because the station's OWN user_id owns no sales data — the orders,
// auction items and inventory all belong to the store OWNERS. So we scope every
// query to those owners, NEVER to the caller. Serves every store the caller's
// ORGANIZATION owns (no store filter on the seed lookup) — via the shared
// requireStationScope, which used to be duplicated inline here without the org
// bound. Same resolution + response shape as /api/shipping/pick-list, reused
// via @/lib/shipping/scanResolve.
//
// Read-only: no scan_log, no shipment_verifications, no live TikTok status
// refresh (that would refresh/persist tokens). Status comes from stored values.
export async function POST(req: Request) {
  // Auth (role === 'station') + the org-bounded owner set, in one place. An unresolved scope is a
  // CONFIG failure and comes back as a 500, never as a no-match scan: running the box query with an
  // empty scope would resolve nothing and masquerade as "label not found".
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  let body: { scan?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const raw = (typeof body.scan === 'string' ? body.scan : '').trim();
  if (!raw) return NextResponse.json({ error: 'Scan a shipping label or order ID' }, { status: 400 });

  // 1–2) Resolve the scanned value → the full physical box (tracking ∪ combine-group).
  const resolved = await resolveBox(admin, ownerIds, raw);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: 'No matching order', scanned_value: raw, parsed_tracking: resolved.parsed_tracking, resolved_via: resolved.resolved_via },
      { status: 404 },
    );
  }
  const { boxRows, orderIds, orderId, groupId, groupKey, tracking, resolvedVia } = resolved;

  // Partition pick vs do-not-pack on STORED status (no live refresh here).
  const effStatus = (id: string) => boxRows.get(id)?.status ?? '';
  // A refund or cancellation outranks the order status — see pick-list, which must behave
  // identically here.
  const refundBlocked = await refundBlockedOrders(admin, ownerIds, orderIds);
  const packStatus = (id: string) => (refundBlocked.has(id) ? REASON_CANCELED : effStatus(id));
  const pickOrderIds = orderIds.filter((id) => !DO_NOT_PACK.has(packStatus(id)));
  const excludedOrderIds = orderIds.filter((id) => DO_NOT_PACK.has(packStatus(id)));

  // 3–6c) Shared assembly: SKU lines + thumbnails + unbound/catalog classification.
  const { skus, excluded, missing_order_ids: unboundIds, missing_orders, catalog_orders, order_types } =
    await assembleBox(admin, ownerIds, {
      boxRows, orderIds, pickOrderIds, excludedOrderIds,
      orderDetail: new Map(),   // no live line-item names on the station path
      statusOf: packStatus,
    });

  return NextResponse.json({
    scanned_value: raw,
    resolved_via: resolvedVia,
    tracking_number: tracking,
    scanned_order_id: orderId,
    group_key: groupKey,
    group_id: groupId,
    order_ids: pickOrderIds,
    order_count: pickOrderIds.length,
    skus,
    catalog_orders,
    order_types,
    missing_order_ids: unboundIds,
    missing_orders,
    excluded,
    excluded_count: excluded.length,
    // Station uses STORED status (no live verification), so flag it as unverified
    // for shape parity with pick-list; the station UI treats this as informational.
    status_unverified: true,
    already_verified_at: null,
  });
}
