import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// POST { fulfillmentOrderId, sectionBarcode, qty? } — picker scans a shelf section.
//
// Strict one-SKU-per-section: the scanned section resolves to exactly one SKU; we
// match it against an UNPICKED line in this box. Wrong section (SKU not in the box,
// or that line already complete) → WRONG_SECTION, line stays unpicked.
// qty defaults to 1 (single scan); the UI passes qty for the required_qty>1 stepper.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { fulfillmentOrderId?: string; sectionBarcode?: string; qty?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const foId = typeof body.fulfillmentOrderId === 'string' ? body.fulfillmentOrderId : '';
  const sectionBarcode = typeof body.sectionBarcode === 'string' ? body.sectionBarcode.trim() : '';
  const qty = Math.max(1, Math.floor(Number(body.qty) || 1));
  if (!foId || !sectionBarcode) return NextResponse.json({ error: 'Missing fulfillmentOrderId or sectionBarcode' }, { status: 400 });

  // Resolve scanned section → SKU (org-shared, active only).
  const { data: section } = await supabase
    .from('pick_sections').select('id, inventory_sku_id, label')
    .eq('org_id', orgId).eq('section_barcode', sectionBarcode).eq('is_active', true)
    .maybeSingle();
  if (!section) return NextResponse.json({ error: 'UNKNOWN_SECTION', message: 'Section barcode not recognized', sectionBarcode }, { status: 404 });

  // Find a not-yet-complete line in this box for that SKU (RLS: owner only).
  const { data: line } = await supabase
    .from('fulfillment_lines')
    .select('id, inventory_sku_id, required_qty, picked, picked_qty')
    .eq('fulfillment_order_id', foId)
    .eq('inventory_sku_id', section.inventory_sku_id)
    .eq('owner_user_id', user.id)
    .maybeSingle();

  if (!line || line.picked) {
    // Scanned section's SKU is not an outstanding line in this box → wrong section.
    return NextResponse.json({
      error: 'WRONG_SECTION',
      message: line?.picked ? 'That SKU is already fully picked' : 'This section\'s SKU is not in this order',
      section_label: section.label,
    }, { status: 409 });
  }

  const newQty = Math.min(line.required_qty, (line.picked_qty || 0) + qty);
  const nowPicked = newQty >= line.required_qty;
  const { data: updated, error: uErr } = await supabase
    .from('fulfillment_lines')
    .update({
      picked_qty: newQty,
      picked: nowPicked,
      picked_at: nowPicked ? new Date().toISOString() : null,
      picked_via_section_id: section.id,
    })
    .eq('id', line.id)
    .select('id, inventory_sku_id, required_qty, picked, picked_qty')
    .single();
  if (uErr) return NextResponse.json({ error: 'Failed to update line', detail: uErr.message }, { status: 500 });

  // Recompute box status: all lines picked → fully_picked, else picking.
  const { data: allLines } = await supabase
    .from('fulfillment_lines').select('picked').eq('fulfillment_order_id', foId).eq('owner_user_id', user.id);
  const allPicked = (allLines ?? []).length > 0 && (allLines ?? []).every((l) => l.picked);
  const newStatus = allPicked ? 'fully_picked' : 'picking';
  await supabase.from('fulfillment_orders').update({ status: newStatus }).eq('id', foId).eq('owner_user_id', user.id);

  return NextResponse.json({ ok: true, line: updated, order_status: newStatus, all_picked: allPicked });
}
