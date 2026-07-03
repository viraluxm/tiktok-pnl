import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// POST: resolve a packing "box" from a scanned slip order_id.
//
// Flow (all reads from our own DB):
//   order_id → synced_order_ids.auto_combine_group_id
//          → all sibling order_ids sharing that group (the whole box)
//          → live_auction_items (client_idempotency_key = order_id)
//          → live_auction_item_skus → inventory_skus
//   aggregated into one block per SKU with the total required qty across the box.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Inventory is ORG-SHARED (035b): a SKU pool row may be owned by the other
  // operator yet referenced by this operator's sold lines. Resolve inventory by
  // org, not user_id — the old user_id filter dropped cross-owner SKUs (e.g. 21/22
  // of Abe's lines). RLS on inventory_skus is is_org_member(org_id), so this is safe.
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { orderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return NextResponse.json({ error: 'Scan a packing slip order ID' }, { status: 400 });

  // 1) The scanned order must be one of ours.
  const { data: scanned } = await supabase
    .from('synced_order_ids')
    .select('order_id, auto_combine_group_id')
    .eq('user_id', user.id)
    .eq('order_id', orderId)
    .maybeSingle();
  if (!scanned) {
    return NextResponse.json({ error: 'Order not found', orderId }, { status: 404 });
  }

  const groupId: string | null = scanned.auto_combine_group_id ?? null;
  const groupKey = groupId ? groupId : `order:${orderId}`;

  // 2) Resolve the box: all orders sharing the group (or just this one).
  let orderIds: string[] = [orderId];
  if (groupId) {
    const { data: siblings } = await supabase
      .from('synced_order_ids')
      .select('order_id')
      .eq('user_id', user.id)
      .eq('auto_combine_group_id', groupId);
    const ids = (siblings ?? []).map((s) => String(s.order_id)).filter(Boolean);
    if (ids.length) orderIds = [...new Set(ids)];
  }

  // 3) Bound auction items for those orders (client_idempotency_key = order_id).
  const { data: items } = await supabase
    .from('live_auction_items')
    .select('id, client_idempotency_key, status')
    .eq('user_id', user.id)
    .in('client_idempotency_key', orderIds);
  const itemRows = items ?? [];
  const itemIds = itemRows.map((i) => i.id);
  const orderIdsWithItems = new Set(itemRows.map((i) => String(i.client_idempotency_key)));
  // A win that was never bound during the live → no auction item for its order.
  const missingOrderIds = orderIds.filter((id) => !orderIdsWithItems.has(id));

  // 4) SKU lines for those items.
  let skuLines: { inventory_sku_id: string; qty: number }[] = [];
  if (itemIds.length) {
    const { data: lines } = await supabase
      .from('live_auction_item_skus')
      .select('inventory_sku_id, qty')
      .eq('user_id', user.id)
      .in('auction_item_id', itemIds);
    skuLines = (lines ?? []).map((l) => ({ inventory_sku_id: String(l.inventory_sku_id), qty: Number(l.qty) || 1 }));
  }

  // Aggregate required qty per inventory SKU across the whole box.
  const requiredBySku = new Map<string, number>();
  for (const l of skuLines) requiredBySku.set(l.inventory_sku_id, (requiredBySku.get(l.inventory_sku_id) ?? 0) + l.qty);

  // 5) Enrich with live inventory details (title / image / barcode for matching).
  const skuIds = [...requiredBySku.keys()];
  let skus: Array<Record<string, unknown>> = [];
  if (skuIds.length) {
    const { data: inv } = await supabase
      .from('inventory_skus')
      .select('id, sku_number, title, barcode, thumbnail_path')
      .eq('org_id', orgId)
      .in('id', skuIds);
    skus = (inv ?? []).map((s) => {
      const path = (s.thumbnail_path as string | null) ?? null;
      const thumbnail_url = path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null;
      return {
        inventory_sku_id: String(s.id),
        sku_number: s.sku_number,
        title: s.title || 'Untitled',
        barcode: s.barcode,
        thumbnail_url,
        required_qty: requiredBySku.get(String(s.id)) ?? 1,
      };
    });
    // Stable order: lowest SKU# first.
    skus.sort((a, b) => Number(a.sku_number) - Number(b.sku_number));
  }

  // 6) Already verified?
  const { data: verified } = await supabase
    .from('shipment_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('group_key', groupKey)
    .maybeSingle();

  return NextResponse.json({
    scanned_order_id: orderId,
    group_key: groupKey,
    group_id: groupId,
    order_ids: orderIds,
    order_count: orderIds.length,
    skus,
    missing_order_ids: missingOrderIds,
    already_verified_at: verified?.verified_at ?? null,
  });
}
