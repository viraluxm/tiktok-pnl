import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SLOT_COLS = 'id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active';

// PATCH — assign or clear the SKU in one section.
//
// Clearing is a first-class operation, not an error case: an empty section is the normal
// state of a sold-out position, and scanning one tells the picker "no SKU assigned".
//
// There is no both-sides flag. Since each face has its own section layout, section 3 of side
// A is not necessarily behind section 3 of side B, so pairing them structurally would be a
// lie. "Picked from both sides" is simply the same SKU assigned to a section on each side,
// and deriveRoute resolves it by walking to whichever face comes first.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { inventory_sku_id?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const skuId = typeof body.inventory_sku_id === 'string' && body.inventory_sku_id
    ? body.inventory_sku_id
    : null;

  // Verify the SKU belongs to this account before pointing a section at it. The FK
  // guarantees the row exists; it does NOT guarantee it is the caller's.
  if (skuId) {
    const { data: sku, error: skuErr } = await supabase
      .from('inventory_skus').select('id').eq('id', skuId).eq('user_id', user.id).maybeSingle();
    if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });
    if (!sku) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
  }

  const { data: slot, error } = await supabase
    .from('pick_slots')
    .update({ inventory_sku_id: skuId })
    .eq('id', id).eq('user_id', user.id)
    .select(SLOT_COLS)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!slot) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  return NextResponse.json({ slot });
}

// DELETE — remove one section from a shelf face.
//
// Refuses without ?confirm=1 when the section holds a SKU, for the same reason the rack and
// shelf paths do: unmapping a SKU should never be a side effect of a layout tweak.
//
// The survivors are NOT renumbered. A face left with S1 and S3 keeps those numbers, because
// renumbering would change the address printed on labels already on the rack — the exact
// relabelling churn the permanent slot code exists to prevent.
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
