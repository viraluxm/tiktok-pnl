import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { DO_NOT_PACK, resolveBox, assembleBox } from '@/lib/shipping/scanResolve';

export const dynamic = 'force-dynamic';

// GET /api/member/oos?scan=<tracking number | order id> — "which item in this box is out of stock?"
//
// THE PROBLEM IT SOLVES. A picker scans a label, the device shows OUT OF STOCK on an item, and the
// whole box goes on the out-of-stock pile. Later, someone else is in TikTok Seller Center holding
// that label and has to cancel the offending line. For a one-item box that is obvious. For a box
// with 2+ items they were guessing — Seller Center knows nothing about our SKUs or our stock.
//
// The answer already exists and is already stored: live_auction_item_skus.short_at_bind, surfaced
// per SKU by assembleBox as `shelf_out` — the same value the picking device drew its band from.
// Nothing new is captured here; this is purely the read-back that was missing. Measured on live
// 2026-09-08: of 263 unshipped boxes carrying a flag, 196 are multi-item with EXACTLY ONE flagged
// SKU — the case this endpoint exists for.
//
// IT NEVER CONSULTS qty_on_hand. That counter is global and runs negative on anything that ships
// daily (see the note at PackStationOverlay.tsx:831 and migration 104's header), so it cannot say
// whether THIS box's unit was the short one. A confident wrong answer here gets a good line
// cancelled on a real customer order, which is worse than "nothing is flagged".
//
// Reuses resolveBox + assembleBox verbatim — the same pair behind /api/station/scan and
// /api/shipping/pick-list — so box resolution (tracking ∪ combine-group) cannot drift between the
// picker's device and this lookup. If they disagreed, this whole feature would be a liability.
//
// READ-ONLY. No scan_log, no shipment_verifications, no TikTok call, no token refresh.
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const raw = (new URL(req.url).searchParams.get('scan') ?? '').trim();
  if (!raw) return NextResponse.json({ error: 'Enter a tracking number or order ID' }, { status: 400 });

  const resolved = await resolveBox(admin, ownerIds, raw);
  if (!resolved.ok) {
    return NextResponse.json({
      error: 'No matching order',
      scanned_value: raw,
      parsed_tracking: resolved.parsed_tracking,
      resolved_via: resolved.resolved_via,
    }, { status: 404 });
  }

  const { boxRows, orderIds, orderId, groupId, groupKey, tracking, resolvedVia, storeId } = resolved;

  // Store scope. A store-restricted member must not read another store's box; an all-stores member
  // skips it. Fail as NOT FOUND rather than 403 — telling them "that box exists but is not yours"
  // leaks the box's existence, and for this workflow the two are the same dead end anyway.
  if (!allStores && (!storeId || !storeIds.includes(storeId))) {
    return NextResponse.json({ error: 'No matching order', scanned_value: raw }, { status: 404 });
  }

  const effStatus = (id: string) => boxRows.get(id)?.status ?? '';
  const pickOrderIds = orderIds.filter((id) => !DO_NOT_PACK.has(effStatus(id)));
  const excludedOrderIds = orderIds.filter((id) => DO_NOT_PACK.has(effStatus(id)));

  const { skus, excluded, missing_order_ids, missing_orders, catalog_orders, order_types } =
    await assembleBox(admin, ownerIds, {
      boxRows, orderIds, pickOrderIds, excludedOrderIds,
      orderDetail: new Map(),   // no live TikTok line names — that would mean a token refresh
      statusOf: effStatus,
    });

  const flagged = skus.filter((s) => s.shelf_out);

  // The verdict is the whole point, so it is computed here rather than left to the client to infer:
  //   one     → cancel exactly this line in Seller Center
  //   several → 2+ short lines; show them ALL, never pick one (cancelling the wrong line is worse)
  //   none    → nothing flagged. Say so plainly; do NOT fall back to a stock guess.
  const verdict = flagged.length === 1 ? 'one' : flagged.length > 1 ? 'several' : 'none';

  return NextResponse.json({
    scanned_value: raw,
    resolved_via: resolvedVia,
    tracking_number: tracking,
    scanned_order_id: orderId,
    order_ids: pickOrderIds,
    order_count: pickOrderIds.length,
    group_key: groupKey,
    group_id: groupId,
    verdict,
    flagged_sku_ids: flagged.map((s) => s.inventory_sku_id),
    item_count: skus.reduce((n, s) => n + (Number(s.required_qty) || 0), 0),
    skus,
    // Carried through so the page can explain an unexpectedly short item list rather than
    // silently showing fewer items than the box holds.
    catalog_orders,
    order_types,
    missing_order_ids,
    missing_orders,
    excluded,
  });
}
