import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  canChangeSide, MAX_SECTIONS_PER_SIDE, SECTION_SIDES,
  type SlotLike, type SectionSide,
} from '@/lib/mapping/shape';

export const dynamic = 'force-dynamic';

const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// PATCH — set the SKU in a section and/or which side(s) it is picked from.
//
// Clearing the SKU is a first-class operation, not an error case: an empty section is the
// normal state of a sold-out position, and scanning one tells the picker "no SKU assigned".
//
// Changing side to 'AB' is the "picked from both sides" action. It can be refused: the
// section already occupies a position in its current aisle, but the aisle it is gaining may
// already be full.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { inventory_sku_id?: string | null; side?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const { data: slot, error: readErr } = await supabase
    .from('pick_slots')
    .select('id, rack_id, shelf_index, section_index, side, inventory_sku_id')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!slot) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  const patch: Record<string, unknown> = {};

  if ('inventory_sku_id' in body) {
    const skuId = typeof body.inventory_sku_id === 'string' && body.inventory_sku_id
      ? body.inventory_sku_id
      : null;
    // Verify the SKU belongs to this account. The FK guarantees the row exists; it does NOT
    // guarantee it is the caller's.
    if (skuId) {
      const { data: sku, error: skuErr } = await supabase
        .from('inventory_skus').select('id').eq('id', skuId).eq('user_id', user.id).maybeSingle();
      if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });
      if (!sku) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
    }
    patch.inventory_sku_id = skuId;
  }

  if (typeof body.side === 'string') {
    if (!(SECTION_SIDES as string[]).includes(body.side)) {
      return NextResponse.json({ error: 'side must be A, B or AB' }, { status: 400 });
    }
    const nextSide = body.side as SectionSide;
    if (nextSide !== slot.side) {
      const { data: siblings, error: sibErr } = await supabase
        .from('pick_slots')
        .select('id, shelf_index, section_index, side, inventory_sku_id')
        .eq('rack_id', slot.rack_id).eq('user_id', user.id);
      if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 });

      if (!canChangeSide((siblings ?? []) as SlotLike[], slot as SlotLike, nextSide)) {
        return NextResponse.json(
          {
            error: `That aisle already has ${MAX_SECTIONS_PER_SIDE} sections on this shelf, so this section cannot also be picked from it.`,
          },
          { status: 409 },
        );
      }
      patch.side = nextSide;
    }
  }

  if (!Object.keys(patch).length) return NextResponse.json({ slot });

  const { data: updated, error } = await supabase
    .from('pick_slots')
    .update(patch)
    .eq('id', id).eq('user_id', user.id)
    .select(SLOT_COLS)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ slot: updated });
}

// DELETE — remove one section from a shelf.
//
// Refuses without ?confirm=1 when the section holds a SKU, for the same reason the rack and
// shelf paths do: unmapping a SKU should never be a side effect of a layout tweak.
//
// Survivors are NOT renumbered. A shelf left with S1 and S3 keeps those numbers, because
// renumbering would change the address printed on labels already on the rack.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const confirmed = new URL(req.url).searchParams.get('confirm') === '1';

  const { data: slot, error: readErr } = await supabase
    .from('pick_slots')
    .select('id, inventory_sku_id')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!slot) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  if (slot.inventory_sku_id && !confirmed) {
    return NextResponse.json(
      {
        error: 'That section still holds a SKU.',
        needs_confirmation: true,
        assigned_lost: 1,
        skus_unmapped: [slot.inventory_sku_id],
      },
      { status: 409 },
    );
  }

  const { error } = await supabase.from('pick_slots').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
