import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

const SELECT_COLS =
  'id, sku_number, barcode, title, thumbnail_path, shortcut_letter, unit_cost_cents, qty_on_hand, weight_oz, length_in, width_in, height_in, category, is_active, created_at, updated_at';

function genBarcode(skuNumber: number): string {
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  return `SKU${skuNumber}-${suffix}`;
}

function extFor(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
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

// Attach a public display URL derived from the stored object path.
function withThumb(supabase: SupabaseClient, row: Record<string, unknown>) {
  const path = (row.thumbnail_path as string | null) ?? null;
  const thumbnail_url = path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null;
  return { ...row, thumbnail_url };
}

function fileFrom(fd: FormData, key: string): File | null {
  const v = fd.get(key);
  if (v && typeof v === 'object' && 'arrayBuffer' in v && (v as File).size > 0) return v as File;
  return null;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // SHARED inventory: scope to the org via RLS (org-membership), not user_id, so
  // every member sees the same pool. RLS already restricts to the caller's org.
  const { data, error } = await supabase
    .from('inventory_skus')
    .select(SELECT_COLS)
    .order('sku_number', { ascending: true });

  if (error) {
    console.error('[inventory/skus] list error:', error);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  }

  // Attach FIFO cost layers (oldest first) per SKU so the UI can show the
  // breakdown and the bind flow can detect Option-X oversell client-side.
  const { data: batchRows } = await supabase
    .from('sku_batches')
    .select('id, sku_id, sequence, qty_remaining, unit_cost_cents')
    .order('sequence', { ascending: true });
  const batchesBySku = new Map<string, Record<string, unknown>[]>();
  for (const b of batchRows ?? []) {
    const k = b.sku_id as string;
    if (!batchesBySku.has(k)) batchesBySku.set(k, []);
    batchesBySku.get(k)!.push({
      id: b.id, sequence: b.sequence,
      qty_remaining: b.qty_remaining, unit_cost_cents: b.unit_cost_cents,
    });
  }
  return NextResponse.json({
    skus: (data ?? []).map((r) => ({
      ...withThumb(supabase, r),
      batches: batchesBySku.get(r.id as string) ?? [],
    })),
  });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === 'string' ? v : '';
  };

  const skuNumber = intOrNull(str('sku_number'));
  if (skuNumber === null || skuNumber <= 0) {
    return NextResponse.json({ error: 'sku_number must be a positive integer' }, { status: 400 });
  }

  const image = fileFrom(fd, 'image');
  if (image) {
    if (!ALLOWED_TYPES.has(image.type)) {
      return NextResponse.json({ error: 'Image must be JPEG, PNG, or WebP' }, { status: 415 });
    }
    if (image.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Image must be 5 MB or smaller' }, { status: 413 });
    }
  }

  const base = {
    user_id: user.id,
    sku_number: skuNumber,
    title: str('title').trim(),
    shortcut_letter: normLetter(str('shortcut_letter')),
    unit_cost_cents: intOrNull(str('unit_cost_cents')),
    qty_on_hand: intOrNull(str('qty_on_hand')) ?? 0,
    weight_oz: numOrNull(str('weight_oz')),
    length_in: numOrNull(str('length_in')),
    width_in: numOrNull(str('width_in')),
    height_in: numOrNull(str('height_in')),
    category: str('category').trim() ? str('category').trim() : null,
    is_active: str('is_active') === '' ? true : str('is_active') === 'true',
  };

  // Insert the row first (server-generated barcode, retry on the rare collision).
  let created: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('inventory_skus')
      .insert({ ...base, barcode: genBarcode(skuNumber) })
      .select(SELECT_COLS)
      .single();

    if (!error) { created = data; break; }

    if (error.code === '23505') {
      const msg = `${error.message} ${error.details ?? ''}`.toLowerCase();
      if (msg.includes('barcode')) continue;
      if (msg.includes('shortcut')) {
        return NextResponse.json({ error: 'That shortcut letter is already in use' }, { status: 409 });
      }
      return NextResponse.json({ error: `SKU number ${skuNumber} already exists` }, { status: 409 });
    }
    console.error('[inventory/skus] create error:', error);
    return NextResponse.json({ error: 'Failed to create SKU' }, { status: 500 });
  }
  if (!created) {
    return NextResponse.json({ error: 'Could not allocate a unique barcode, try again' }, { status: 500 });
  }

  // FIFO: every SKU must have a cost layer. Create the seq-1 batch = the entered
  // qty @ cost (quick-add sends qty 0 → a 0-qty layer that goes negative on the
  // first oversell bind). On failure, compensate by removing the orphan SKU so a
  // SKU never exists without a batch.
  const { data: firstBatch, error: batchErr } = await supabase.from('sku_batches').insert({
    user_id: user.id,
    sku_id: created.id as string,
    qty_remaining: (created.qty_on_hand as number | null) ?? 0,
    unit_cost_cents: (created.unit_cost_cents as number | null) ?? null,
    sequence: 1,
  }).select('id, sequence, qty_remaining, unit_cost_cents').single();
  if (batchErr || !firstBatch) {
    await supabase.from('inventory_skus').delete().eq('id', created.id as string).eq('user_id', user.id);
    console.error('[inventory/skus] initial batch insert failed:', batchErr);
    return NextResponse.json({ error: 'Failed to create SKU cost layer' }, { status: 500 });
  }
  const batches = [firstBatch];

  // Upload the image (if any) to the user's own folder, then save its path.
  if (image) {
    const path = `${user.id}/skus/${created.id}.${extFor(image.type)}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, image, {
      contentType: image.type,
      upsert: true,
    });
    if (upErr) {
      console.error('[inventory/skus] image upload failed (non-fatal):', upErr);
      // SKU is created; just return it without a thumbnail.
      return NextResponse.json({ sku: { ...withThumb(supabase, created), batches }, imageError: 'Image upload failed' }, { status: 201 });
    }
    const { data: updated } = await supabase
      .from('inventory_skus')
      .update({ thumbnail_path: path })
      .eq('id', created.id as string)
      .eq('user_id', user.id)
      .select(SELECT_COLS)
      .single();
    created = updated ?? { ...created, thumbnail_path: path };
  }

  return NextResponse.json({ sku: { ...withThumb(supabase, created), batches } }, { status: 201 });
}
