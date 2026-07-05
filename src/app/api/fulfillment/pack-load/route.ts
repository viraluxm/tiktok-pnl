import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { printLabel } from '@/lib/fulfillment/printLabel';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// POST { cubicleBarcode } — packer scans a cubicle at the station (the START action;
// the pack-queue list is only a guide). ORG-SCOPED: loads whichever active box sits in
// the scanned cubicle (either store) and, simultaneously:
//   (a) triggers the label print (STUB — labels were pre-bought at "Buy labels"), and
//   (b) returns the box's item cards for the packer's visual backstop check.
// Empty cubicle → 'empty'. The scan IS the verification the bin matches the order.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { cubicleBarcode?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const cubicleBarcode = typeof body.cubicleBarcode === 'string' ? body.cubicleBarcode.trim() : '';
  if (!cubicleBarcode) return NextResponse.json({ error: 'Scan a cubicle' }, { status: 400 });

  const { data: cubicle } = await supabase
    .from('cubicles').select('id, cubicle_number')
    .eq('org_id', orgId).eq('cubicle_barcode', cubicleBarcode).eq('is_active', true)
    .maybeSingle();
  if (!cubicle) return NextResponse.json({ error: 'UNKNOWN_CUBICLE', message: 'Cubicle barcode not recognized' }, { status: 404 });

  // ORG-SHARED: load whichever active box sits in this cubicle (either store).
  const { data: box } = await supabase
    .from('fulfillment_orders')
    .select('id, group_key, order_ids, status, cubicle_id')
    .eq('cubicle_id', cubicle.id).in('status', ['assigned', 'packing'])
    .maybeSingle();
  if (!box) {
    return NextResponse.json({ state: 'empty', cubicle_number: cubicle.cubicle_number, message: `Cubicle ${cubicle.cubicle_number} is empty` });
  }

  const { data: lines } = await supabase
    .from('fulfillment_lines')
    .select('id, inventory_sku_id, required_qty, picked, picked_qty')
    .eq('fulfillment_order_id', box.id);

  // Enrich with inventory details for visual confirmation (items have no barcodes).
  const skuIds = (lines ?? []).map((l) => String(l.inventory_sku_id));
  let invMap = new Map<string, Record<string, unknown>>();
  if (skuIds.length) {
    const { data: inv } = await supabase
      .from('inventory_skus').select('id, sku_number, title, thumbnail_path').eq('org_id', orgId).in('id', skuIds);
    invMap = new Map((inv ?? []).map((s) => {
      const path = (s.thumbnail_path as string | null) ?? null;
      const thumbnail_url = path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null;
      return [String(s.id), { sku_number: s.sku_number, title: s.title, thumbnail_url }];
    }));
  }

  if (box.status === 'assigned') {
    await supabase.from('fulfillment_orders').update({ status: 'packing' }).eq('id', box.id);
  }

  // Label prints AT scan time (stub) — pre-bought at "Buy labels". Items returned too,
  // so print + visual backstop happen simultaneously.
  const label = await printLabel({ group_key: box.group_key, order_ids: box.order_ids });

  return NextResponse.json({
    state: 'loaded',
    cubicle_number: cubicle.cubicle_number,
    label,
    fulfillment_order_id: box.id,
    group_key: box.group_key,
    order_ids: box.order_ids,
    status: 'packing',
    lines: (lines ?? [])
      .map((l) => ({ ...l, ...(invMap.get(String(l.inventory_sku_id)) ?? {}) }) as Record<string, unknown>)
      .sort((a, b) => Number(a.sku_number ?? 0) - Number(b.sku_number ?? 0)),
  });
}
