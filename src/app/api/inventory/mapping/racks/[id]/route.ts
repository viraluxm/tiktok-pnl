import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clampShelves, clampSections, planReshape, type ExistingSlot } from '@/lib/mapping/shape';
import { generateSlotCode } from '@/lib/mapping/slotCode';

export const dynamic = 'force-dynamic';

const RACK_COLS =
  'id, name, grid_row, grid_col, shelf_count, sections_per_shelf, route_pos_a, route_pos_b, is_active';
const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// Position, name and route pins are free to change. Shape changes are not: they add and
// destroy slots, so they go through planReshape and need confirmation when anything
// assigned would be lost.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    name?: string;
    grid_row?: number;
    grid_col?: number;
    shelf_count?: number;
    sections_per_shelf?: number;
    route_pos_a?: number | null;
    route_pos_b?: number | null;
    is_active?: boolean;
    confirm_destructive?: boolean;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const { data: rack, error: readErr } = await supabase
    .from('pick_racks').select(RACK_COLS).eq('id', id).eq('user_id', user.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!rack) return NextResponse.json({ error: 'Rack not found' }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 24);
  if (Number.isFinite(body.grid_row)) patch.grid_row = Math.trunc(body.grid_row as number);
  if (Number.isFinite(body.grid_col)) patch.grid_col = Math.trunc(body.grid_col as number);
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
  // null is meaningful here — it clears a pin and returns the stop to the derived order —
  // so these are checked for presence rather than truthiness.
  if ('route_pos_a' in body) patch.route_pos_a = body.route_pos_a == null ? null : Math.trunc(Number(body.route_pos_a));
  if ('route_pos_b' in body) patch.route_pos_b = body.route_pos_b == null ? null : Math.trunc(Number(body.route_pos_b));

  const nextShelves = body.shelf_count == null ? rack.shelf_count : clampShelves(Number(body.shelf_count));
  const nextSections = body.sections_per_shelf == null ? rack.sections_per_shelf : clampSections(Number(body.sections_per_shelf));
  const reshaping = nextShelves !== rack.shelf_count || nextSections !== rack.sections_per_shelf;

  if (reshaping) {
    const { data: existing, error: slotsErr } = await supabase
      .from('pick_slots')
      .select('id, shelf_index, section_index, side, inventory_sku_id')
      .eq('rack_id', id).eq('user_id', user.id);
    if (slotsErr) return NextResponse.json({ error: slotsErr.message }, { status: 500 });

    const plan = planReshape((existing ?? []) as ExistingSlot[], nextShelves, nextSections);

    // Surfaced BEFORE anything is destroyed. The UI turns this into a confirmation naming
    // what would be lost, rather than the operator discovering it afterwards.
    if (plan.assignedLost > 0 && !body.confirm_destructive) {
      return NextResponse.json(
        {
          error: 'This resize would destroy slots that currently hold a SKU.',
          needs_confirmation: true,
          assigned_lost: plan.assignedLost,
          skus_unmapped: plan.skusUnmapped,
          slots_destroyed: plan.toDeleteIds.length,
          slots_created: plan.toCreate.length,
        },
        { status: 409 },
      );
    }

    if (plan.toDeleteIds.length) {
      const { error } = await supabase
        .from('pick_slots').delete().in('id', plan.toDeleteIds).eq('user_id', user.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (plan.toCreate.length) {
      const { error } = await supabase.from('pick_slots').insert(
        plan.toCreate.map((p) => ({
          user_id: user.id,
          rack_id: id,
          shelf_index: p.shelf_index,
          section_index: p.section_index,
          side: p.side,
          slot_code: generateSlotCode(),
        })),
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    patch.shelf_count = nextShelves;
    patch.sections_per_shelf = nextSections;
  }

  if (Object.keys(patch).length) {
    const { error } = await supabase
      .from('pick_racks').update(patch).eq('id', id).eq('user_id', user.id);
    if (error) {
      const msg = error.code === '23505'
        ? 'Another rack already has that name or occupies that grid position.'
        : error.message;
      return NextResponse.json({ error: msg }, { status: error.code === '23505' ? 409 : 500 });
    }
  }

  const [{ data: updated }, { data: slots }] = await Promise.all([
    supabase.from('pick_racks').select(RACK_COLS).eq('id', id).eq('user_id', user.id).single(),
    supabase.from('pick_slots').select(SLOT_COLS).eq('rack_id', id).eq('user_id', user.id),
  ]);
  return NextResponse.json({ rack: updated, slots: slots ?? [] });
}

// DELETE — removes the rack and cascades to its slots (FK on delete cascade, migration 115).
// Refuses without ?confirm=1 when any slot still holds a SKU, so deleting a rack cannot
// quietly unmap part of the catalogue.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const confirmed = new URL(req.url).searchParams.get('confirm') === '1';

  const { data: assigned, error: countErr } = await supabase
    .from('pick_slots')
    .select('inventory_sku_id')
    .eq('rack_id', id).eq('user_id', user.id)
    .not('inventory_sku_id', 'is', null);
  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 });

  const assignedCount = assigned?.length ?? 0;
  if (assignedCount > 0 && !confirmed) {
    return NextResponse.json(
      {
        error: 'This rack still has SKUs mapped to it.',
        needs_confirmation: true,
        assigned_lost: assignedCount,
        skus_unmapped: Array.from(new Set((assigned ?? []).map((s) => s.inventory_sku_id))),
      },
      { status: 409 },
    );
  }

  const { error } = await supabase.from('pick_racks').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
