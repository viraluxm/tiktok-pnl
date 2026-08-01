// SINGLE SOURCE OF TRUTH for order-row parsing + the tracking-safe upsert. Both the interactive
// sync (/api/tiktok/sync) and the scheduled cron import parseOrder from here, so an order is parsed
// identically no matter which path fetched it — no drift, no reconciliation surprises. parseOrder
// was lifted verbatim out of the sync route in one isolated commit; the split-write upsert is
// factored the same way the route writes it (tracking-null rows omit tracking_number so a stored
// value is never null-overwritten as an order ships).
import type { createAdminClient } from '@/lib/supabase/admin';

type AdminClient = ReturnType<typeof createAdminClient>;

const SHOP_TIMEZONE = 'America/Los_Angeles';

export function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

// Unix seconds → YYYY-MM-DD in the shop's timezone.
export function toLocalDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
}

// Parse one TikTok order into a synced_order_ids row (minus store_id, stamped by the caller).
// Byte-for-byte the same logic the interactive sync uses.
export function parseOrder(userId: string, o: Record<string, unknown>): Record<string, unknown> {
  const orderId = String(o.id || '');
  const createTime = o.create_time as number;
  const date = createTime ? toLocalDate(createTime) : '';
  const orderCreatedAt = createTime ? new Date(createTime * 1000).toISOString() : null;
  const updateTime = o.update_time as number;
  const updatedDate = updateTime ? toLocalDate(updateTime) : '';
  const status = String(o.status || '').toUpperCase();
  const autoCombineGroupId = o.auto_combine_group_id != null ? String(o.auto_combine_group_id) || null : null;
  const trackingNumber = String(o.tracking_number || '') || null;
  const payment = (o.payment || {}) as Record<string, unknown>;
  const productPrice = toNum(payment.original_total_product_price) || toNum(payment.sub_total) || 0;
  const shippingFee = toNum(payment.shipping_fee) || 0;
  const sellerDiscount = toNum(payment.seller_discount) || 0;
  const platformDiscount = toNum(payment.platform_discount) || 0;
  const gmv = productPrice + shippingFee - sellerDiscount - platformDiscount;
  const shipping = shippingFee;
  const platformFee = toNum(payment.platform_commission) || toNum(payment.platform_fee) || 0;
  let affiliate = toNum(payment.affiliate_commission) || toNum(payment.creator_commission) || 0;

  const lineItems = (o.line_items || o.order_line_list || []) as Record<string, unknown>[];
  let units = 0;
  let tikTokProductId: string | null = null;
  let skuId: string | null = null;
  let skuName: string | null = null;
  let productName: string | null = null;
  for (const item of lineItems) {
    units += Number(item.quantity) || 1;
    if (affiliate === 0) affiliate += toNum(item.affiliate_commission) || toNum(item.creator_commission) || 0;
    if (!tikTokProductId) {
      tikTokProductId = String(item.product_id || '') || null;
      skuId = String(item.sku_id || '') || null;
      skuName = String(item.sku_name || '') || null;
      productName = String(item.product_name || '') || null;
    }
  }
  if (units === 0) units = 1;

  return {
    user_id: userId, order_id: orderId, order_date: date, updated_date: updatedDate,
    order_created_at: orderCreatedAt,
    gmv, shipping, affiliate, platform_fee: platformFee, units,
    tiktok_product_id: tikTokProductId, sku_id: skuId, sku_name: skuName,
    product_name: productName, status, auto_combine_group_id: autoCombineGroupId,
    tracking_number: trackingNumber,
  };
}

// Tracking-safe bulk upsert (mirrors the interactive sync): rows WITH a tracking value upsert every
// column; rows WITHOUT one omit tracking_number so a stored value is never null-overwritten as an
// order ships. product_name is stripped (not a DB column); store_id is stamped from the caller.
export async function upsertOrderRows(
  admin: AdminClient,
  storeId: string,
  parsedRows: Record<string, unknown>[],
): Promise<{ written: number; error: string | null }> {
  if (!parsedRows.length) return { written: 0, error: null };
  const dbRows: Record<string, unknown>[] = parsedRows.map(({ product_name: _pn, ...rest }) => ({ ...rest, store_id: storeId }));
  const withTracking = dbRows.filter((r) => r.tracking_number != null);
  const withoutTracking: Record<string, unknown>[] = dbRows.filter((r) => r.tracking_number == null).map(({ tracking_number: _tn, ...rest }) => rest);
  let error: string | null = null;
  if (withTracking.length) {
    const { error: e } = await admin.from('synced_order_ids').upsert(withTracking, { onConflict: 'user_id,order_id' });
    if (e) error = e.message;
  }
  if (!error && withoutTracking.length) {
    const { error: e } = await admin.from('synced_order_ids').upsert(withoutTracking, { onConflict: 'user_id,order_id' });
    if (e) error = e.message;
  }
  return { written: error ? 0 : parsedRows.length, error };
}
