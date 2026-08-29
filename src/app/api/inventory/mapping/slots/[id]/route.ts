import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// PATCH — assign or clear the SKU in a slot.
//
// `both_sides: true` applies the same change to the opposite face of the SAME section. That
// is the whole implementation of "this SKU is picked from both sides": there is no
// double-sided flag anywhere, because a flag could contradict the assignments it claims to
// describe. Two faces holding the same SKU IS the double-sided state, and the picker's
// route simply takes whichever face it reaches first.
//
// Clearing is a first-class operation, not an error case — an empty slot is the normal
// state of a sold-out position, and scanning one tells the picker "no SKU assigned".
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { inventory_sku_id?: string | null; both_sides?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const skuId = typeof body.inventory_sku_id === 'string' && body.inventory_sku_id
    ? body.inventory_sku_id
    : null;

  const { data: slot, error: readErr } = await supabase
    .from('pick_slots')
    .select('id, rack_id, shelf_index, section_index, side')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!slot) return NextResponse.json({ error: 'Slot not found' }, { status: 404 });

  // Verify the SKU belongs to this account before pointing a slot at it. The FK guarantees
  // the row exists; it does NOT guarantee it is the caller's.
  if (skuId) {
    const { data: sku, error: skuErr } = await supabase
      .from('inventory_skus').select('id').eq('id', skuId).eq('user_id', user.id).maybeSingle();
    if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });
    if (!sku) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
  }

  const targetIds = [id];
  if (body.both_sides) {
    const { data: pair } = await supabase
      .from('pick_slots')
      .select('id')
      .eq('user_id', user.id)
      .eq('rack_id', slot.rack_id)
      .eq('shelf_index', slot.shelf_index)
      .eq('section_index', slot.section_index)
      .neq('side', slot.side)
      .maybeSingle();
    if (pair) targetIds.push(pair.id);
  }

  const { error } = await supabase
    .from('pick_slots')
    .update({ inventory_sku_id: skuId })
    .in('id', targetIds)
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: slots } = await supabase
    .from('pick_slots').select(SLOT_COLS).in('id', targetIds).eq('user_id', user.id);
  return NextResponse.json({ slots: slots ?? [] });
}
