import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails'; // same product-image source the pack station uses

// POST { fulfillmentOrderId } — load an EXISTING box for the pick checklist.
// ORG-SCOPED: reads the box + lines by id under org RLS (any picker, either store).
// This is the queue-tap load — it does NOT re-resolve from owner-scoped order tables
// (those belong to whichever store sold the order); the lines already exist from buy-labels.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { fulfillmentOrderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  if (!foId) return NextResponse.json({ error: 'Missing fulfillmentOrderId' }, { status: 400 });

  const { data: box } = await supabase
    .from('fulfillment_orders')
    .select('id, group_key, order_ids, status, cubicle_id, missing_order_ids')
    .eq('id', foId).maybeSingle(); // org RLS scopes visibility
  if (!box) return NextResponse.json({ error: 'Box not found' }, { status: 404 });

  const { data: lines } = await supabase
    .from('fulfillment_lines')
    .select('inventory_sku_id, required_qty, picked, picked_qty')
    .eq('fulfillment_order_id', foId);

  const skuIds = [...new Set((lines ?? []).map((l) => String(l.inventory_sku_id)))];
  const [{ data: inv }, { data: secs }] = await Promise.all([
    skuIds.length ? supabase.from('inventory_skus').select('id, sku_number, title, thumbnail_path').eq('org_id', orgId).in('id', skuIds) : Promise.resolve({ data: [] as Array<{ id: string; sku_number: number; title: string; thumbnail_path: string | null }> }),
    // Section resolved LIVE by inventory_sku_id (not a baked expected_section_id) so the
    // "no section mapped" flag reflects CURRENT mappings — re-adding a section in Settings
    // clears it immediately, regardless of when the box was created.
    skuIds.length ? supabase.from('pick_sections').select('id, inventory_sku_id, label').eq('org_id', orgId).eq('is_active', true).in('inventory_sku_id', skuIds) : Promise.resolve({ data: [] as Array<{ id: string; inventory_sku_id: string; label: string | null }> }),
  ]);
  const invById = new Map((inv ?? []).map((s) => [String(s.id), s]));
  const secBySku = new Map((secs ?? []).map((s) => [String(s.inventory_sku_id), s]));

  return NextResponse.json({
    fulfillment_order_id: box.id,
    group_key: box.group_key,
    order_ids: box.order_ids,
    status: box.status,
    cubicle_id: box.cubicle_id,
    lines: (lines ?? [])
      .map((l) => {
        const s = invById.get(String(l.inventory_sku_id));
        const sec = secBySku.get(String(l.inventory_sku_id)) ?? null;
        const path = s ? (s.thumbnail_path as string | null) : null;
        const thumbnail_url = path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null;
        return {
          inventory_sku_id: String(l.inventory_sku_id),
          sku_number: s ? (s.sku_number as number) : null,
          title: s ? ((s.title as string) || 'Untitled') : 'Unknown SKU',
          thumbnail_url,
          required_qty: l.required_qty as number,
          picked: l.picked as boolean,
          picked_qty: l.picked_qty as number,
          expected_section_id: sec ? sec.id : null,
          expected_section_label: sec ? (sec.label ?? null) : null,
          has_section: !!sec,
        };
      })
      .sort((a, b) => Number(a.sku_number ?? 0) - Number(b.sku_number ?? 0)),
    missing_order_ids: (box.missing_order_ids as string[]) ?? [],
  });
}
