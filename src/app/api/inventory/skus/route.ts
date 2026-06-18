import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, sku_number, barcode, title, shortcut_letter, unit_cost_cents, qty_on_hand, weight_oz, length_in, width_in, height_in, category, is_active, created_at, updated_at';

function genBarcode(skuNumber: number): string {
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  return `SKU${skuNumber}-${suffix}`;
}

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

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('inventory_skus')
    .select(SELECT_COLS)
    .eq('user_id', user.id)
    .order('sku_number', { ascending: true });

  if (error) {
    console.error('[inventory/skus] list error:', error);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  }
  return NextResponse.json({ skus: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const skuNumber = intOrNull(body.sku_number);
  if (skuNumber === null || skuNumber <= 0) {
    return NextResponse.json({ error: 'sku_number must be a positive integer' }, { status: 400 });
  }

  const base = {
    user_id: user.id,
    sku_number: skuNumber,
    title: typeof body.title === 'string' ? body.title.trim() : '',
    shortcut_letter: normLetter(body.shortcut_letter),
    unit_cost_cents: intOrNull(body.unit_cost_cents),
    qty_on_hand: intOrNull(body.qty_on_hand) ?? 0,
    weight_oz: numOrNull(body.weight_oz),
    length_in: numOrNull(body.length_in),
    width_in: numOrNull(body.width_in),
    height_in: numOrNull(body.height_in),
    category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
  };

  // Barcode is server-generated; retry on the rare collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('inventory_skus')
      .insert({ ...base, barcode: genBarcode(skuNumber) })
      .select(SELECT_COLS)
      .single();

    if (!error) return NextResponse.json({ sku: data }, { status: 201 });

    if (error.code === '23505') {
      const msg = `${error.message} ${error.details ?? ''}`.toLowerCase();
      if (msg.includes('barcode')) continue; // collision, regenerate
      if (msg.includes('shortcut')) {
        return NextResponse.json({ error: 'That shortcut letter is already in use' }, { status: 409 });
      }
      return NextResponse.json({ error: `SKU number ${skuNumber} already exists` }, { status: 409 });
    }
    console.error('[inventory/skus] create error:', error);
    return NextResponse.json({ error: 'Failed to create SKU' }, { status: 500 });
  }
  return NextResponse.json({ error: 'Could not allocate a unique barcode, try again' }, { status: 500 });
}
