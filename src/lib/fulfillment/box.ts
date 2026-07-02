import type { SupabaseClient } from '@supabase/supabase-js';

// Shared box resolver/creator used by BOTH entry points:
//   - /api/fulfillment/build-box  (picker scans a slip → load/create, status 'picking')
//   - /api/fulfillment/buy-labels (operator buys labels for a session → create, 'unpicked')
//
// Resolution chain (ORG-SHARED inventory per 035b):
//   synced_order_ids → auto_combine_group_id → sibling orders (the "box")
//   → live_auction_items (client_idempotency_key = order_id)  [owner-scoped: the sale]
//   → live_auction_item_skus → aggregate qty per inventory SKU
//   → inventory_skus (org) → pick_sections (expected section)
// NON-DESTRUCTIVE: find-or-create the box; build lines once; return live pick state.

export interface BoxLine {
  inventory_sku_id: string;
  sku_number: number | null;
  title: string;
  required_qty: number;
  picked: boolean;
  picked_qty: number;
  expected_section_id: string | null;
  expected_section_label: string | null;
  has_section: boolean;
}
export interface BoxResult {
  fulfillment_order_id: string;
  group_key: string;
  order_ids: string[];
  status: string;
  lines: BoxLine[];
  missing_order_ids: string[];
}
export type BoxOutcome = { ok: true; box: BoxResult } | { ok: false; status: number; error: string };

export async function resolveAndUpsertBox(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  anchorOrderId: string,
  initialStatus: 'picking' | 'unpicked' = 'picking',
): Promise<BoxOutcome> {
  // 1) anchor order must be ours
  const { data: scanned } = await supabase
    .from('synced_order_ids').select('order_id, auto_combine_group_id, store_id')
    .eq('user_id', userId).eq('order_id', anchorOrderId).maybeSingle();
  if (!scanned) return { ok: false, status: 404, error: 'Order not found' };

  const groupId: string | null = scanned.auto_combine_group_id ?? null;
  const groupKey = groupId ? groupId : `order:${anchorOrderId}`;
  const storeId = (scanned.store_id as string | null) ?? null;

  // 2) box = all orders sharing the group
  let orderIds: string[] = [anchorOrderId];
  if (groupId) {
    const { data: siblings } = await supabase
      .from('synced_order_ids').select('order_id')
      .eq('user_id', userId).eq('auto_combine_group_id', groupId);
    const ids = (siblings ?? []).map((s) => String(s.order_id)).filter(Boolean);
    if (ids.length) orderIds = [...new Set(ids)];
  }

  // 3) bound auction items
  const { data: items } = await supabase
    .from('live_auction_items').select('id, client_idempotency_key')
    .eq('user_id', userId).in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemIds = itemRows.map((i) => i.id);
  const withItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
  const missingOrderIds = orderIds.filter((id) => !withItems.has(id));

  // 4) aggregate qty per inventory SKU
  const requiredBySku = new Map<string, number>();
  if (itemIds.length) {
    const { data: lines } = await supabase
      .from('live_auction_item_skus').select('inventory_sku_id, qty')
      .eq('user_id', userId).in('auction_item_id', itemIds);
    for (const l of lines ?? []) {
      const id = String(l.inventory_sku_id);
      requiredBySku.set(id, (requiredBySku.get(id) ?? 0) + (Number(l.qty) || 1));
    }
  }
  const skuIds = [...requiredBySku.keys()];

  // 5) inventory (org-shared) + expected sections
  let inv: Array<Record<string, unknown>> = [];
  let sections: Array<Record<string, unknown>> = [];
  if (skuIds.length) {
    const [{ data: invRows }, { data: secRows }] = await Promise.all([
      supabase.from('inventory_skus').select('id, sku_number, title').eq('org_id', orgId).in('id', skuIds),
      supabase.from('pick_sections').select('id, inventory_sku_id, label').eq('org_id', orgId).eq('is_active', true).in('inventory_sku_id', skuIds),
    ]);
    inv = invRows ?? [];
    sections = secRows ?? [];
  }
  const sectionBySku = new Map(sections.map((s) => [String(s.inventory_sku_id), s]));

  // 6) find-or-create box (non-destructive)
  let foRow: { id: string; status: string };
  const { data: existingFo } = await supabase
    .from('fulfillment_orders').select('id, status')
    .eq('owner_user_id', userId).eq('group_key', groupKey).maybeSingle();
  if (existingFo) {
    foRow = existingFo as { id: string; status: string };
  } else {
    const { data: created, error: foErr } = await supabase
      .from('fulfillment_orders')
      .insert({ owner_user_id: userId, org_id: orgId, store_id: storeId, group_key: groupKey, order_ids: orderIds, status: initialStatus })
      .select('id, status').single();
    if (foErr || !created) return { ok: false, status: 500, error: foErr?.message ?? 'Failed to create box' };
    foRow = created as { id: string; status: string };
  }
  const fulfillmentOrderId = foRow.id;

  // 6b) Persist the unbound set (orders in this box with NO live binding). Kept fresh on
  //     every resolve (owner context) so the picker's flag is reliable cross-store.
  await supabase.from('fulfillment_orders').update({ missing_order_ids: missingOrderIds }).eq('id', fulfillmentOrderId);

  // 7) build lines once
  const { data: existingLines } = await supabase
    .from('fulfillment_lines').select('id').eq('fulfillment_order_id', fulfillmentOrderId).limit(1);
  if ((!existingLines || existingLines.length === 0) && skuIds.length) {
    const lineRows = skuIds.map((sku) => {
      const sec = sectionBySku.get(sku);
      return {
        fulfillment_order_id: fulfillmentOrderId, owner_user_id: userId, inventory_sku_id: sku,
        expected_section_id: sec ? (sec.id as string) : null,
        required_qty: requiredBySku.get(sku) ?? 1, picked: false, picked_qty: 0,
      };
    });
    const { error: lErr } = await supabase.from('fulfillment_lines').insert(lineRows);
    if (lErr) return { ok: false, status: 500, error: lErr.message };
  }

  // 8) live line state
  const { data: curLines } = await supabase
    .from('fulfillment_lines')
    .select('inventory_sku_id, required_qty, picked, picked_qty, expected_section_id')
    .eq('fulfillment_order_id', fulfillmentOrderId).eq('owner_user_id', userId);
  const invBySku = new Map(inv.map((s) => [String(s.id), s]));

  const boxLines: BoxLine[] = (curLines ?? [])
    .map((l) => {
      const sku = String(l.inventory_sku_id);
      const s = invBySku.get(sku);
      const sec = sectionBySku.get(sku);
      return {
        inventory_sku_id: sku,
        sku_number: s ? (s.sku_number as number) : null,
        title: s ? ((s.title as string) || 'Untitled') : 'Unknown SKU',
        required_qty: l.required_qty as number,
        picked: l.picked as boolean,
        picked_qty: l.picked_qty as number,
        expected_section_id: (l.expected_section_id as string | null) ?? null,
        expected_section_label: sec ? ((sec.label as string) ?? null) : null,
        has_section: !!sec,
      };
    })
    .sort((a, b) => Number(a.sku_number ?? 0) - Number(b.sku_number ?? 0));

  return {
    ok: true,
    box: { fulfillment_order_id: fulfillmentOrderId, group_key: groupKey, order_ids: orderIds, status: foRow.status, lines: boxLines, missing_order_ids: missingOrderIds },
  };
}
