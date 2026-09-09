import { NextResponse } from 'next/server';
import { requireSellerScope } from '@/lib/seller/guard';

export const dynamic = 'force-dynamic';

// GET /api/seller/inventory — the SHARED catalog a seller sells from. READ ONLY.
//
// This is the one thing a seller sees of ours, and it is deliberate: they sell from our stock, so
// they need to know what exists, how much is left and what it costs them. Cost is included by
// decision — a seller who cannot see cost cannot tell whether a price loses money.
//
// Read as the CALLER, not service-role, so the org RLS on inventory_skus (is_org_member) still
// applies beneath the explicit org filter below. Two independent reasons the wrong org's rows
// cannot come back, rather than one.
//
// There is no POST/PATCH/DELETE here, and /api/inventory/* (which has them) is not in the seller
// allowlist — a seller reads the catalog and never edits it. Quantities move through the sale
// path, not through this route.
const SELECT_COLS =
  'id, sku_number, barcode, title, thumbnail_path, unit_cost_cents, qty_on_hand, category, is_active, live_seller_notes';

export async function GET() {
  const scope = await requireSellerScope();
  if (!scope.ok) return scope.response;
  const { supabase, orgId } = scope;

  const { data, error } = await supabase
    .from('inventory_skus')
    .select(SELECT_COLS)
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('sku_number', { ascending: true });

  if (error) {
    console.error('[seller/inventory] read failed:', error.message);
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 });
  }

  return NextResponse.json({ skus: data ?? [] });
}
