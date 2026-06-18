import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, sku_number, barcode, title, shortcut_letter, unit_cost_cents, qty_on_hand, weight_oz, length_in, width_in, height_in, category, is_active, created_at, updated_at';

function normLetter(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  return t ? t.slice(0, 2) : null;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// PATCH: update mutable fields. sku_number and barcode are immutable.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if ('title' in body) patch.title = typeof body.title === 'string' ? body.title.trim() : '';
  if ('shortcut_letter' in body) patch.shortcut_letter = normLetter(body.shortcut_letter);
  if ('unit_cost_cents' in body) patch.unit_cost_cents = intOrNull(body.unit_cost_cents);
  if ('qty_on_hand' in body) patch.qty_on_hand = intOrNull(body.qty_on_hand) ?? 0;
  if ('weight_oz' in body) patch.weight_oz = numOrNull(body.weight_oz);
  if ('length_in' in body) patch.length_in = numOrNull(body.length_in);
  if ('width_in' in body) patch.width_in = numOrNull(body.width_in);
  if ('height_in' in body) patch.height_in = numOrNull(body.height_in);
  if ('category' in body)
    patch.category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null;
  if ('is_active' in body) patch.is_active = Boolean(body.is_active);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('inventory_skus')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const msg = `${error.message} ${error.details ?? ''}`.toLowerCase();
      if (msg.includes('shortcut')) {
        return NextResponse.json({ error: 'That shortcut letter is already in use' }, { status: 409 });
      }
    }
    console.error('[inventory/skus] update error:', error);
    return NextResponse.json({ error: 'Failed to update SKU' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
  return NextResponse.json({ sku: data });
}

// DELETE: blocked (409) if the SKU has already been used in an auction (FK RESTRICT).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: refs } = await supabase
    .from('live_auction_item_skus')
    .select('id')
    .eq('inventory_sku_id', id)
    .eq('user_id', user.id)
    .limit(1);

  if (refs && refs.length > 0) {
    return NextResponse.json(
      { error: "This SKU has been used in a session and can't be deleted. Deactivate it instead.", reason: 'referenced' },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from('inventory_skus')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    if (error.code === '23503') {
      return NextResponse.json(
        { error: "This SKU has been used in a session and can't be deleted. Deactivate it instead.", reason: 'referenced' },
        { status: 409 },
      );
    }
    console.error('[inventory/skus] delete error:', error);
    return NextResponse.json({ error: 'Failed to delete SKU' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
