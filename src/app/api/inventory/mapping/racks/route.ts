import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clampShelves, nextRackName } from '@/lib/mapping/shape';

export const dynamic = 'force-dynamic';

const RACK_COLS = 'id, name, grid_row, grid_col, shelf_count, route_pos_a, route_pos_b, is_active';

// POST — create a rack. The only thing asked for is HOW MANY SHELVES.
//
// The rack is created EMPTY: no sections, no slots. Sections are added one at a time from
// the rack view, because a rack's faces are not a uniform grid — one side may hold 4
// sections while the other holds 6. Generating a grid up front would impose exactly the
// uniformity the model exists to avoid.
//
// The name is assigned server-side (R1, R2, R3…). Naming a rack is busywork, and free text
// drifts out of sync with what is painted on the floor.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { grid_row?: number; grid_col?: number; shelf_count?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const gridRow = Number.isFinite(body.grid_row) ? Math.trunc(body.grid_row as number) : 0;
  const gridCol = Number.isFinite(body.grid_col) ? Math.trunc(body.grid_col as number) : 0;
  const shelfCount = clampShelves(Number(body.shelf_count ?? 2));

  // Two tabs creating a rack at once can pick the same name; the (user_id, name) unique
  // constraint catches it, so re-read and retry once rather than surfacing a collision the
  // operator can do nothing about.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: existing, error: readErr } = await supabase
      .from('pick_racks').select('name').eq('user_id', user.id);
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    const name = nextRackName((existing ?? []).map((r) => r.name as string));

    const { data: rack, error } = await supabase
      .from('pick_racks')
      .insert({ user_id: user.id, name, grid_row: gridRow, grid_col: gridCol, shelf_count: shelfCount })
      .select(RACK_COLS)
      .single();

    if (!error) return NextResponse.json({ rack, slots: [] }, { status: 201 });

    if (error.code === '23505' && attempt === 0) continue; // name raced, or cell taken
    const msg = error.code === '23505'
      ? 'Another rack already occupies that grid position.'
      : error.message;
    return NextResponse.json({ error: msg }, { status: error.code === '23505' ? 409 : 500 });
  }

  return NextResponse.json({ error: 'Could not allocate a rack name' }, { status: 500 });
}
