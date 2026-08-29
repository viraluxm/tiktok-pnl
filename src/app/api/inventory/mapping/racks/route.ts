import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clampShelves, clampSections, slotPositions } from '@/lib/mapping/shape';
import { generateSlotCode } from '@/lib/mapping/slotCode';

export const dynamic = 'force-dynamic';

// POST — create a rack and mint every slot underneath it in one go.
//
// A rack is useless without slots, so they are created together rather than lazily: the
// operator adds a rack and can immediately print its labels and start assigning. Slot codes
// are minted here (not by a DB default) matching how inventory_skus.barcode and
// employee_badges.code are already generated in application code.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    name?: string;
    grid_row?: number;
    grid_col?: number;
    shelf_count?: number;
    sections_per_shelf?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 24) : '';
  if (!name) return NextResponse.json({ error: 'A rack name is required' }, { status: 400 });

  const gridRow = Number.isFinite(body.grid_row) ? Math.trunc(body.grid_row as number) : 0;
  const gridCol = Number.isFinite(body.grid_col) ? Math.trunc(body.grid_col as number) : 0;
  const shelfCount = clampShelves(Number(body.shelf_count ?? 2));
  const sectionsPerShelf = clampSections(Number(body.sections_per_shelf ?? 2));

  const { data: rack, error: rackErr } = await supabase
    .from('pick_racks')
    .insert({
      user_id: user.id,
      name,
      grid_row: gridRow,
      grid_col: gridCol,
      shelf_count: shelfCount,
      sections_per_shelf: sectionsPerShelf,
    })
    .select('id, name, grid_row, grid_col, shelf_count, sections_per_shelf, route_pos_a, route_pos_b, is_active')
    .single();

  if (rackErr) {
    // 23505 = the (user_id, name) unique or the one-active-rack-per-cell partial index.
    const msg = rackErr.code === '23505'
      ? 'A rack with that name, or another rack in that grid position, already exists.'
      : rackErr.message;
    return NextResponse.json({ error: msg }, { status: rackErr.code === '23505' ? 409 : 500 });
  }

  const slotRows = slotPositions(shelfCount, sectionsPerShelf).map((p) => ({
    user_id: user.id,
    rack_id: rack.id,
    shelf_index: p.shelf_index,
    section_index: p.section_index,
    side: p.side,
    slot_code: generateSlotCode(),
  }));

  const { data: slots, error: slotErr } = await supabase
    .from('pick_slots')
    .insert(slotRows)
    .select('id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active');

  if (slotErr) {
    // Roll the rack back by hand — there is no transaction across two PostgREST calls, and a
    // rack with no slots is a broken state the UI cannot repair on its own.
    await supabase.from('pick_racks').delete().eq('id', rack.id).eq('user_id', user.id);
    return NextResponse.json({ error: `Could not create slots: ${slotErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ rack, slots: slots ?? [] }, { status: 201 });
}
