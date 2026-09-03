import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  nextSectionIndex, MAX_SECTIONS_PER_SIDE, SECTION_SIDES,
  type SlotLike, type SectionSide,
} from '@/lib/mapping/shape';
import { generateSlotCode } from '@/lib/mapping/slotCode';

export const dynamic = 'force-dynamic';

const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// POST — add ONE section to a shelf.
//
// This is the atom of the Mapping UI: you look at a shelf and divide it once more. A section
// is one physical space; `side` says which aisle(s) it is picked from ('A', 'B', or 'AB' for
// both). Adding a section NEVER creates a matching one on the other side — that was the
// behaviour the per-face model implied and this model exists to remove.
//
// The section number is assigned server-side as max + 1 across the whole shelf, never
// "lowest unused": reissuing a number would silently change the address printed on a label
// already sitting on the rack.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { rack_id?: string; shelf_index?: number; side?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const rackId = typeof body.rack_id === 'string' ? body.rack_id : '';
  const shelf = Math.trunc(Number(body.shelf_index));
  const side = (SECTION_SIDES as string[]).includes(body.side ?? 'A')
    ? ((body.side ?? 'A') as SectionSide)
    : null;
  if (!rackId || !Number.isFinite(shelf) || shelf < 1 || !side) {
    return NextResponse.json(
      { error: 'rack_id, shelf_index and side (A, B or AB) are required' },
      { status: 400 },
    );
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
    // An 'AB' section needs room in BOTH aisles, so it can be refused even when one side has
    // space — say which limit was hit rather than just "full".
    return NextResponse.json(
      {
        error: side === 'AB'
          ? `A section picked from both sides needs room on each, and this shelf already has ${MAX_SECTIONS_PER_SIDE} on one of them.`
          : `This shelf already has ${MAX_SECTIONS_PER_SIDE} sections on side ${side}.`,
      },
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
