import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// GET /api/fulfillment/pack-queue — "Orders Ready to Pack".
// ORG-SCOPED: cubicles holding an assigned/packing (picked, not-yet-shipped) box across
// BOTH stores, sorted ship_by ascending (oldest/most-urgent first). NO urgency tiers —
// plain FIFO guide. The row is a GUIDE ONLY; the packer must SCAN the cubicle to start.
const READY = ['assigned', 'packing'];

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: boxes } = await supabase
    .from('fulfillment_orders')
    .select('id, group_key, order_ids, status, store_id, ship_by, ordered_at, cubicle_id, missing_order_ids')
    .in('status', READY)
    .not('cubicle_id', 'is', null)
    .order('ship_by', { ascending: true, nullsFirst: false });
  const rows = boxes ?? [];
  if (rows.length === 0) return NextResponse.json({ queue: [] });

  const foIds = rows.map((b) => b.id);
  const storeIds = [...new Set(rows.map((b) => b.store_id).filter(Boolean))] as string[];
  const cubicleIds = [...new Set(rows.map((b) => b.cubicle_id).filter(Boolean))] as string[];

  const [{ data: lines }, { data: stores }, { data: cubicles }] = await Promise.all([
    supabase.from('fulfillment_lines').select('fulfillment_order_id, inventory_sku_id, required_qty').in('fulfillment_order_id', foIds),
    storeIds.length ? supabase.from('stores').select('id, name').in('id', storeIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    cubicleIds.length ? supabase.from('cubicles').select('id, cubicle_number').in('id', cubicleIds) : Promise.resolve({ data: [] as { id: string; cubicle_number: number }[] }),
  ]);

  const skuIds = [...new Set((lines ?? []).map((l) => String(l.inventory_sku_id)))];
  const { data: inv } = skuIds.length
    ? await supabase.from('inventory_skus').select('id, sku_number, title').eq('org_id', orgId).in('id', skuIds)
    : { data: [] as { id: string; sku_number: number; title: string }[] };

  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const cubNum = new Map((cubicles ?? []).map((c) => [c.id, c.cubicle_number]));
  const invById = new Map((inv ?? []).map((s) => [String(s.id), s]));
  const linesByFo = new Map<string, Array<{ sku_number: number | null; title: string; required_qty: number }>>();
  for (const l of lines ?? []) {
    const s = invById.get(String(l.inventory_sku_id));
    const arr = linesByFo.get(l.fulfillment_order_id) ?? [];
    arr.push({ sku_number: s ? (s.sku_number as number) : null, title: s ? (s.title as string) : 'Unknown SKU', required_qty: l.required_qty as number });
    linesByFo.set(l.fulfillment_order_id, arr);
  }

  const queue = rows
    .filter((b) => b.cubicle_id != null) // guard: only cubicled boxes
    .map((b) => ({
      fulfillment_order_id: b.id,
      group_key: b.group_key,
      order_ids: b.order_ids,
      status: b.status,
      store: b.store_id ? (storeName.get(b.store_id) ?? 'Unknown store') : '—',
      ship_by: b.ship_by,
      ordered_at: b.ordered_at,
      cubicle_number: b.cubicle_id ? (cubNum.get(b.cubicle_id) ?? null) : null,
      unbound_count: ((b.missing_order_ids as string[]) ?? []).length,
      lines: (linesByFo.get(b.id) ?? []).sort((a, z) => Number(a.sku_number ?? 0) - Number(z.sku_number ?? 0)),
    }));

  return NextResponse.json({ queue });
}
