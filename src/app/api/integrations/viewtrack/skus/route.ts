import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertViewTrackAuth, IntegrationError } from '@/lib/integrations/viewtrack-auth';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// Endpoint A — read the org's SKU catalog for ViewTrack's SKU picker.
// Shared-secret + service-role; org-scoped explicitly (RLS is bypassed).
// Exposes CATALOG fields only — no costs, no orders, no P&L, no internal ids
// beyond the SKU id needed to map + post batches.
export async function GET(req: Request) {
  let ctx;
  try {
    ctx = assertViewTrackAuth(req);
  } catch (e) {
    if (e instanceof IntegrationError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const supabase = createAdminClient();

  const { data: skus, error } = await supabase
    .from('inventory_skus')
    .select('id, sku_number, title, thumbnail_path, qty_on_hand, is_active')
    .eq('org_id', ctx.orgId)
    .order('sku_number', { ascending: true });

  if (error) {
    console.error('[integrations/viewtrack/skus] list error:', error);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }

  // Batch counts per SKU (org-scoped), so the picker can show layer depth without
  // exposing per-batch costs.
  const { data: batchRows, error: bErr } = await supabase
    .from('sku_batches')
    .select('sku_id')
    .eq('org_id', ctx.orgId);
  if (bErr) {
    console.error('[integrations/viewtrack/skus] batch count error:', bErr);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }
  const countBySku = new Map<string, number>();
  for (const r of batchRows ?? []) {
    const k = r.sku_id as string;
    countBySku.set(k, (countBySku.get(k) ?? 0) + 1);
  }

  const out = (skus ?? []).map((s) => {
    const path = (s.thumbnail_path as string | null) ?? null;
    const thumbnail_url = path
      ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
      : null;
    return {
      id: s.id,
      sku_number: s.sku_number,
      title: s.title,
      thumbnail_url,
      qty_on_hand: s.qty_on_hand,
      is_active: s.is_active,
      batch_count: countBySku.get(s.id as string) ?? 0,
    };
  });

  return NextResponse.json({ skus: out });
}
