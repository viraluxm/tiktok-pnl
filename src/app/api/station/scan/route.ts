import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { DO_NOT_PACK, resolveBox, assembleBox } from '@/lib/shipping/scanResolve';

export const dynamic = 'force-dynamic';

// POST /api/station/scan — the warehouse fulfillment station's read-only scan.
//
// Gated on app_metadata.role === 'station'. Uses the service role for data
// access because the station's OWN user_id owns no sales data — the orders,
// auction items and inventory all belong to the store OWNERS. So we resolve the
// owner user_ids from store_members (role='owner') and scope every query to
// those, NEVER to the caller. Serves ALL stores (no store filter on the seed
// lookup). Same resolution + response shape as /api/shipping/pick-list, reused
// via @/lib/shipping/scanResolve.
//
// Read-only: no scan_log, no shipment_verifications, no live TikTok status
// refresh (that would refresh/persist tokens). Status comes from stored values.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'station') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { scan?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const raw = (typeof body.scan === 'string' ? body.scan : '').trim();
  if (!raw) return NextResponse.json({ error: 'Scan a shipping label or order ID' }, { status: 400 });

  const admin = createAdminClient();

  // Resolve the data owners: every store owner, across ALL stores. The station is
  // scoped to THEIR data, never to the caller (whose user_id has none).
  const { data: owners, error: ownersErr } = await admin
    .from('store_members')
    .select('user_id')
    .eq('role', 'owner');
  if (ownersErr) return NextResponse.json({ error: ownersErr.message }, { status: 500 });
  const ownerIds = [...new Set((owners ?? []).map((o) => String(o.user_id)))];
  // No owner rows → the station's data scope is unresolved. This is a CONFIG
  // failure, not a no-match scan: never run the box query with an empty scope
  // (an empty `.in()` would resolve nothing and masquerade as "label not found").
  // Fail loud with a 500 so it's diagnosed, not mistaken for a bad label.
  if (!ownerIds.length) {
    console.error('[station/scan] station scope unresolved: no store_members(role=owner) rows');
    return NextResponse.json({ error: 'station scope unresolved' }, { status: 500 });
  }

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
  const pickOrderIds = orderIds.filter((id) => !DO_NOT_PACK.has(effStatus(id)));
  const excludedOrderIds = orderIds.filter((id) => DO_NOT_PACK.has(effStatus(id)));

  // 3–6c) Shared assembly: SKU lines + thumbnails + unbound/catalog classification.
  const { skus, excluded, missing_order_ids: unboundIds, missing_orders, catalog_orders, order_types } =
    await assembleBox(admin, ownerIds, {
      boxRows, orderIds, pickOrderIds, excludedOrderIds,
      orderDetail: new Map(),   // no live line-item names on the station path
      statusOf: effStatus,
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
