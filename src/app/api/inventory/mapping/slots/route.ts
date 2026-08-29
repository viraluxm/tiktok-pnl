import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { nextSectionIndex, MAX_SECTIONS, type SlotLike, type Side } from '@/lib/mapping/shape';
import { generateSlotCode } from '@/lib/mapping/slotCode';

export const dynamic = 'force-dynamic';

const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// POST — add ONE section to one shelf face.
//
// This is the atom of the Mapping UI: you look at a shelf face and click to divide it once
// more. The section number is assigned server-side as max + 1 for that face, never "lowest
// unused" — reissuing a number would silently change the address printed on a label already
// sitting on the rack.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { rack_id?: string; shelf_index?: number; side?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const rackId = typeof body.rack_id === 'string' ? body.rack_id : '';
  const shelf = Math.trunc(Number(body.shelf_index));
  const side = body.side === 'A' || body.side === 'B' ? (body.side as Side) : null;
  if (!rackId || !Number.isFinite(shelf) || shelf < 1 || !side) {
    return NextResponse.json({ error: 'rack_id, shelf_index and side (A or B) are required' }, { status: 400 });
  }

  const { data: rack, error: rackErr } = await supabase
    .from('pick_racks').select('id, shelf_count').eq('id', rackId).eq('user_id', user.id).maybeSingle();
  if (rackErr) return NextResponse.json({ error: rackErr.message }, { status: 500 });
  if (!rack) return NextResponse.json({ error: 'Rack not found' }, { status: 404 });
  if (shelf > rack.shelf_count) {
    return NextResponse.json({ error: `This rack only has ${rack.shelf_count} shelves.` }, { status: 400 });
  }

  const { data: slots, error: slotsErr } = await supabase
    .from('pick_slots')
    .select('id, shelf_index, section_index, side, inventory_sku_id')
    .eq('rack_id', rackId).eq('user_id', user.id);
  if (slotsErr) return NextResponse.json({ error: slotsErr.message }, { status: 500 });

  const next = nextSectionIndex((slots ?? []) as SlotLike[], shelf, side);
  if (next === null) {
    return NextResponse.json(
      { error: `That shelf face is already divided into ${MAX_SECTIONS} sections.` },
      { status: 409 },
    );
  }

  const { data: slot, error } = await supabase
    .from('pick_slots')
    .insert({
      user_id: user.id,
      rack_id: rackId,
      shelf_index: shelf,
      section_index: next,
      side,
      slot_code: generateSlotCode(),
    })
    .select(SLOT_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ slot }, { status: 201 });
}
