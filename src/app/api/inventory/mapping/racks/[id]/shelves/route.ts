import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  planShelfInsert, planShelfRemove, MIN_SHELVES, MAX_SHELVES, type SlotLike,
} from '@/lib/mapping/shape';

export const dynamic = 'force-dynamic';

const RACK_COLS = 'id, name, grid_row, grid_col, shelf_count, route_pos_a, route_pos_b, is_active';
const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// Insert or remove ONE shelf, wherever it sits in the rack.
//
// The old shelf stepper could only add to the top, which is not how a rack gets rebuilt — a
// new shelf usually goes between two existing ones.
//
// RENUMBERING. Shelf numbers are ordinal, so inserting below L3 makes the old L3 into L4.
// Every affected slot's shelf_index changes, which means every printed label above the
// insertion point now shows the wrong level. The BARCODE still resolves (it encodes an opaque
// slot id, not the address), so picking keeps working — it is the human caption that goes
// stale. The response reports exactly how many labels that is so the UI can say so.
//
// ORDER MATTERS. pick_slots has a unique (rack_id, shelf_index, section_index), so shifting a
// block of shelves cannot be done as one bulk +1: the first row written would collide with the
// shelf above it. Shelves are therefore moved one level at a time, DESCENDING when shifting up
// and ASCENDING when shifting down, so the destination level is always empty before anything
// lands in it.

async function loadRack(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;

  const { data: rack, error } = await supabase
    .from('pick_racks').select(RACK_COLS).eq('id', id).eq('user_id', user.id).maybeSingle();
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) } as const;
  if (!rack) return { error: NextResponse.json({ error: 'Rack not found' }, { status: 404 }) } as const;

  const { data: slots, error: sErr } = await supabase
    .from('pick_slots')
    .select('id, shelf_index, section_index, side, inventory_sku_id')
    .eq('rack_id', id).eq('user_id', user.id);
  if (sErr) return { error: NextResponse.json({ error: sErr.message }, { status: 500 }) } as const;

  return { supabase, user, rack, slots: (slots ?? []) as SlotLike[] } as const;
}

/** Move every slot on `from` to `to`. Callers sequence these so the target is always free. */
async function moveShelf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rackId: string,
  userId: string,
  from: number,
  to: number,
) {
  return supabase
    .from('pick_slots')
    .update({ shelf_index: to })
    .eq('rack_id', rackId).eq('user_id', userId).eq('shelf_index', from);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadRack(id);
  if ('error' in ctx) return ctx.error;
  const { supabase, user, rack, slots } = ctx;

  let body: { at?: number; position?: 'above' | 'below' };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const at = Math.trunc(Number(body.at));
  const position = body.position === 'below' ? 'below' : 'above';
  if (!Number.isFinite(at) || at < 1 || at > rack.shelf_count) {
    return NextResponse.json({ error: 'That shelf does not exist.' }, { status: 400 });
  }
  if (rack.shelf_count >= MAX_SHELVES) {
    return NextResponse.json(
      { error: `A rack holds at most ${MAX_SHELVES} shelves.` },
      { status: 409 },
    );
  }

  const plan = planShelfInsert(slots, at, position);

  // Descending: the highest shelf moves up first, so its destination is empty.
  for (let level = rack.shelf_count; level >= plan.shiftFrom; level--) {
    const { error } = await moveShelf(supabase, id, user.id, level, level + 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: rErr } = await supabase
    .from('pick_racks')
    .update({ shelf_count: rack.shelf_count + 1 })
    .eq('id', id).eq('user_id', user.id);
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  const [{ data: updated }, { data: after }] = await Promise.all([
    supabase.from('pick_racks').select(RACK_COLS).eq('id', id).eq('user_id', user.id).single(),
    supabase.from('pick_slots').select(SLOT_COLS).eq('rack_id', id).eq('user_id', user.id),
  ]);

  return NextResponse.json({
    rack: updated,
    slots: after ?? [],
    new_shelf_index: plan.newShelfIndex,
    // The reprint cost, stated rather than left to be discovered on the floor.
    labels_to_reprint: plan.renumbered.length,
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadRack(id);
  if ('error' in ctx) return ctx.error;
  const { supabase, user, rack, slots } = ctx;

  const url = new URL(req.url);
  const at = Math.trunc(Number(url.searchParams.get('at')));
  const confirmed = url.searchParams.get('confirm') === '1';

  if (!Number.isFinite(at) || at < 1 || at > rack.shelf_count) {
    return NextResponse.json({ error: 'That shelf does not exist.' }, { status: 400 });
  }
  if (rack.shelf_count <= MIN_SHELVES) {
    return NextResponse.json(
      { error: `A rack needs at least ${MIN_SHELVES} shelves.` },
      { status: 409 },
    );
  }

  const plan = planShelfRemove(slots, at);

  if (plan.assignedLost > 0 && !confirmed) {
    return NextResponse.json(
      {
        error: 'That shelf still holds SKUs.',
        needs_confirmation: true,
        assigned_lost: plan.assignedLost,
        skus_unmapped: plan.skusUnmapped,
      },
      { status: 409 },
    );
  }

  if (plan.toDeleteIds.length) {
    const { error } = await supabase
      .from('pick_slots').delete().in('id', plan.toDeleteIds).eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Ascending: the level just above the hole moves down first, into space now vacated.
  for (let level = at + 1; level <= rack.shelf_count; level++) {
    const { error } = await moveShelf(supabase, id, user.id, level, level - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: rErr } = await supabase
    .from('pick_racks')
    .update({ shelf_count: rack.shelf_count - 1 })
    .eq('id', id).eq('user_id', user.id);
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  const [{ data: updated }, { data: after }] = await Promise.all([
    supabase.from('pick_racks').select(RACK_COLS).eq('id', id).eq('user_id', user.id).single(),
    supabase.from('pick_slots').select(SLOT_COLS).eq('rack_id', id).eq('user_id', user.id),
  ]);

  return NextResponse.json({
    rack: updated,
    slots: after ?? [],
    labels_to_reprint: plan.renumbered.length,
  });
}
