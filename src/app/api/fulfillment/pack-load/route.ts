import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// POST { cubicleBarcode } — packer scans a cubicle at the station.
//
// Uses cubicle_state() (SECURITY DEFINER, no-leak) to branch WITHOUT exposing another
// operator's order:
//   'free'              → empty cubicle
//   'occupied_by_other' → neutral "in use by another operator" (no order loaded)
//   'mine'              → load the box + lines (RLS-visible), transition assigned→packing
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

  const { data: state } = await supabase.rpc('cubicle_state', { p_cubicle: cubicle.id });

  if (state === 'free') {
    return NextResponse.json({ state: 'empty', cubicle_number: cubicle.cubicle_number, message: `Cubicle ${cubicle.cubicle_number} is empty` });
  }
  if (state === 'occupied_by_other') {
    return NextResponse.json({ state: 'occupied_by_other', cubicle_number: cubicle.cubicle_number, message: `Cubicle ${cubicle.cubicle_number} is in use by another operator` });
  }

  // 'mine' — load the box (RLS guarantees it's ours) and move to packing.
  const { data: box } = await supabase
    .from('fulfillment_orders')
    .select('id, group_key, order_ids, status, cubicle_id')
    .eq('cubicle_id', cubicle.id).in('status', ['assigned', 'packing']).eq('owner_user_id', user.id)
    .maybeSingle();
  if (!box) return NextResponse.json({ error: 'Box not found for cubicle' }, { status: 404 });

  const { data: lines } = await supabase
    .from('fulfillment_lines')
    .select('id, inventory_sku_id, required_qty, picked, picked_qty')
    .eq('fulfillment_order_id', box.id).eq('owner_user_id', user.id);

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
    await supabase.from('fulfillment_orders').update({ status: 'packing' }).eq('id', box.id).eq('owner_user_id', user.id);
  }

  return NextResponse.json({
    state: 'mine',
    cubicle_number: cubicle.cubicle_number,
    fulfillment_order_id: box.id,
    group_key: box.group_key,
    order_ids: box.order_ids,
    status: 'packing',
    lines: (lines ?? [])
      .map((l) => ({ ...l, ...(invMap.get(String(l.inventory_sku_id)) ?? {}) }) as Record<string, unknown>)
      .sort((a, b) => Number(a.sku_number ?? 0) - Number(b.sku_number ?? 0)),
  });
}
