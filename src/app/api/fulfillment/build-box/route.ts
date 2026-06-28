import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// POST { orderId } — scan a packing slip to enter a box into fulfillment.
//
// Reuses the existing pick-list resolution chain (ORG-SCOPED inventory, per 035b):
//   synced_order_ids → auto_combine_group_id → sibling orders (the "box")
//   → live_auction_items (client_idempotency_key = order_id)  [owner-scoped: the sale]
//   → live_auction_item_skus → aggregate qty per inventory SKU
//   → inventory_skus (org-shared) → pick_sections (expected section per SKU)
// Upserts one fulfillment_orders row per box (owner_user_id, group_key) and rebuilds
// its fulfillment_lines. Lines ALWAYS carry owner_user_id = the box owner (never client).
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { orderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return NextResponse.json({ error: 'Scan a packing slip order ID' }, { status: 400 });

  // 1) The scanned order must be ours; capture its box key + store.
  const { data: scanned } = await supabase
    .from('synced_order_ids')
    .select('order_id, auto_combine_group_id, store_id')
    .eq('user_id', user.id)
    .eq('order_id', orderId)
    .maybeSingle();
  if (!scanned) return NextResponse.json({ error: 'Order not found', orderId }, { status: 404 });

  const groupId: string | null = scanned.auto_combine_group_id ?? null;
  const groupKey = groupId ? groupId : `order:${orderId}`;
  const storeId = (scanned.store_id as string | null) ?? null;

  // 2) Resolve the box: all orders sharing the group (or just this one).
  let orderIds: string[] = [orderId];
  if (groupId) {
    const { data: siblings } = await supabase
      .from('synced_order_ids').select('order_id')
      .eq('user_id', user.id).eq('auto_combine_group_id', groupId);
    const ids = (siblings ?? []).map((s) => String(s.order_id)).filter(Boolean);
    if (ids.length) orderIds = [...new Set(ids)];
  }

  // 3) Bound auction items for those orders (owner-scoped).
  const { data: items } = await supabase
    .from('live_auction_items').select('id, client_idempotency_key')
    .eq('user_id', user.id).in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemIds = itemRows.map((i) => i.id);
  const withItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
  const missingOrderIds = orderIds.filter((id) => !withItems.has(id)); // unbound → no-section list (#2)

  // 4) SKU lines, aggregated per inventory SKU across the box.
  const requiredBySku = new Map<string, number>();
  if (itemIds.length) {
    const { data: lines } = await supabase
      .from('live_auction_item_skus').select('inventory_sku_id, qty')
      .eq('user_id', user.id).in('auction_item_id', itemIds);
    for (const l of lines ?? []) {
      const id = String(l.inventory_sku_id);
      requiredBySku.set(id, (requiredBySku.get(id) ?? 0) + (Number(l.qty) || 1));
    }
  }
  const skuIds = [...requiredBySku.keys()];

  // 5) Inventory details (ORG-SHARED) + expected sections.
  let inv: Array<Record<string, unknown>> = [];
  let sections: Array<Record<string, unknown>> = [];
  if (skuIds.length) {
    const [{ data: invRows }, { data: secRows }] = await Promise.all([
      supabase.from('inventory_skus').select('id, sku_number, title, barcode').eq('org_id', orgId).in('id', skuIds),
      supabase.from('pick_sections').select('id, inventory_sku_id, label, section_barcode').eq('org_id', orgId).eq('is_active', true).in('inventory_sku_id', skuIds),
    ]);
    inv = invRows ?? [];
    sections = secRows ?? [];
  }
  const sectionBySku = new Map(sections.map((s) => [String(s.inventory_sku_id), s]));

  // 6) Upsert the box row (owner, group_key) and capture its id.
  const { data: foRow, error: foErr } = await supabase
    .from('fulfillment_orders')
    .upsert(
      { owner_user_id: user.id, org_id: orgId, store_id: storeId, group_key: groupKey, order_ids: orderIds, status: 'picking' },
      { onConflict: 'owner_user_id,group_key' },
    )
    .select('id, status')
    .single();
  if (foErr || !foRow) return NextResponse.json({ error: 'Failed to create fulfillment box', detail: foErr?.message }, { status: 500 });
  const fulfillmentOrderId = foRow.id as string;

  // 7) Rebuild lines (idempotent: clear then insert). owner_user_id = box owner.
  await supabase.from('fulfillment_lines').delete().eq('fulfillment_order_id', fulfillmentOrderId);
  const lineRows = inv.map((s) => {
    const sku = String(s.id);
    const sec = sectionBySku.get(sku);
    return {
      fulfillment_order_id: fulfillmentOrderId,
      owner_user_id: user.id,
      inventory_sku_id: sku,
      expected_section_id: sec ? (sec.id as string) : null,
      required_qty: requiredBySku.get(sku) ?? 1,
      picked: false,
      picked_qty: 0,
    };
  });
  if (lineRows.length) {
    const { error: lErr } = await supabase.from('fulfillment_lines').insert(lineRows);
    if (lErr) return NextResponse.json({ error: 'Failed to create lines', detail: lErr.message }, { status: 500 });
  }

  return NextResponse.json({
    fulfillment_order_id: fulfillmentOrderId,
    group_key: groupKey,
    order_ids: orderIds,
    status: foRow.status,
    lines: inv
      .map((s) => {
        const sku = String(s.id);
        const sec = sectionBySku.get(sku);
        return {
          inventory_sku_id: sku,
          sku_number: s.sku_number,
          title: s.title || 'Untitled',
          required_qty: requiredBySku.get(sku) ?? 1,
          expected_section_id: sec ? sec.id : null,
          expected_section_label: sec ? sec.label : null,
          has_section: !!sec, // false → SKU not mapped to a section yet (Settings TODO)
        };
      })
      .sort((a, b) => Number(a.sku_number) - Number(b.sku_number)),
    missing_order_ids: missingOrderIds, // unbound orders: manual / no-section handling
  });
}
