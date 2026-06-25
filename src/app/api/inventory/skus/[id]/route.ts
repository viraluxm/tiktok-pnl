import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

const SELECT_COLS =
  'id, sku_number, barcode, title, thumbnail_path, shortcut_letter, unit_cost_cents, qty_on_hand, weight_oz, length_in, width_in, height_in, category, is_active, created_at, updated_at';

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

// PATCH (multipart): update mutable fields and/or replace/remove the thumbnail.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
  }

  // SHARED inventory: scope by org so any member can edit the shared SKU.
  const orgId = await getOrgId(supabase, user.id);
  const { data: existing } = await supabase
    .from('inventory_skus')
    .select('id, thumbnail_path')
    .eq('id', id)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });

  const oldPath = (existing.thumbnail_path as string | null) ?? null;
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === 'string' ? v : '';
  };

  const patch: Record<string, unknown> = {};
  if (fd.has('title')) patch.title = str('title').trim();
  if (fd.has('shortcut_letter')) patch.shortcut_letter = normLetter(str('shortcut_letter'));
  if (fd.has('unit_cost_cents')) patch.unit_cost_cents = intOrNull(str('unit_cost_cents'));
  if (fd.has('qty_on_hand')) patch.qty_on_hand = intOrNull(str('qty_on_hand')) ?? 0;
  if (fd.has('weight_oz')) patch.weight_oz = numOrNull(str('weight_oz'));
  if (fd.has('length_in')) patch.length_in = numOrNull(str('length_in'));
  if (fd.has('width_in')) patch.width_in = numOrNull(str('width_in'));
  if (fd.has('height_in')) patch.height_in = numOrNull(str('height_in'));
  if (fd.has('category')) patch.category = str('category').trim() ? str('category').trim() : null;
  if (fd.has('is_active')) patch.is_active = str('is_active') === 'true';

  // Image: replace with a new upload, or remove.
  const newImage = fileFrom(fd, 'image');
  if (newImage) {
    if (!ALLOWED_TYPES.has(newImage.type)) {
      return NextResponse.json({ error: 'Image must be JPEG, PNG, or WebP' }, { status: 415 });
    }
    if (newImage.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Image must be 5 MB or smaller' }, { status: 413 });
    }
    const path = `${user.id}/skus/${id}.${extFor(newImage.type)}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, newImage, {
      contentType: newImage.type,
      upsert: true,
    });
    if (upErr) {
      console.error('[inventory/skus] image upload failed:', upErr);
      return NextResponse.json({ error: 'Image upload failed' }, { status: 500 });
    }
    patch.thumbnail_path = path;
    if (oldPath && oldPath !== path) {
      await supabase.storage.from(BUCKET).remove([oldPath]); // best-effort cleanup of the old ext
    }
  } else if (str('remove_image') === 'true') {
    patch.thumbnail_path = null;
    if (oldPath) await supabase.storage.from(BUCKET).remove([oldPath]);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('inventory_skus')
    .update(patch)
    .eq('id', id)
    .eq('org_id', orgId)
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
  return NextResponse.json({ sku: withThumb(supabase, data) });
}

// DELETE: blocked (409) if the SKU has been used in an auction (FK RESTRICT). Cleans up the image.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // SHARED inventory: scope by org so any member can delete the shared SKU.
  const orgId = await getOrgId(supabase, user.id);
  const { data: existing } = await supabase
    .from('inventory_skus')
    .select('thumbnail_path')
    .eq('id', id)
    .eq('org_id', orgId)
    .maybeSingle();

  // Friendly pre-check (caller's own usage; operations table stays user-scoped).
  // The FK RESTRICT is the authoritative guard across ALL members' auctions.
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
    .eq('org_id', orgId);

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

  const oldPath = (existing?.thumbnail_path as string | null) ?? null;
  if (oldPath) await supabase.storage.from(BUCKET).remove([oldPath]); // best-effort

  return NextResponse.json({ ok: true });
}
