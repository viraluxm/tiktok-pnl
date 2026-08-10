import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';
const TZ = 'America/Los_Angeles'; // server-fixed business tz (see CLAUDE.md)

// GET /api/member/inventory — owner-scoped stock + reorder/velocity for the member 'inventory'
// scope. The velocity columns come from pnl_reorder_by_sku_as (migration 087, applied in prod): an
// owner-scoped, REVENUE-FREE reorder read that is structurally incapable of emitting price/cost.
// We join inventory_skus only for thumbnail_path -> thumbnail_url (same getPublicUrl pattern as
// /api/member/catalog) and unit_cost_cents. This route returns NO revenue, cogs, or net profit —
// those are not in the RPC and must never be added here.
export async function GET() {
  const scope = await requireMemberScope('inventory');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const { data: velo, error: rpcErr } = await admin.rpc('pnl_reorder_by_sku_as', {
    p_owner_user_ids: ownerIds,
    p_tz: TZ,
  });
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

  // inventory_skus supplies only the thumbnail + unit cost, keyed by sku id.
  const { data: skuRows, error: skuErr } = await admin
    .from('inventory_skus')
    .select('id, thumbnail_path, unit_cost_cents')
    .in('user_id', ownerIds);
  if (skuErr) return NextResponse.json({ error: skuErr.message }, { status: 500 });

  const meta = new Map<string, { thumbnail_path: string | null; unit_cost_cents: number | null }>();
  for (const r of skuRows ?? []) {
    meta.set(r.id as string, {
      thumbnail_path: (r.thumbnail_path as string | null) ?? null,
      unit_cost_cents: (r.unit_cost_cents as number | null) ?? null,
    });
  }

  const rows = (velo ?? []) as Array<Record<string, unknown>>;
  const skus = rows.map((row) => {
    const m = meta.get(row.sku_id as string);
    const path = m?.thumbnail_path ?? null;
    return {
      sku_id: row.sku_id as string,
      sku_number: (row.sku_number as number | null) ?? null,
      title: (row.title as string | null) ?? null,
      thumbnail_url: path ? admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
      qty_on_hand: (row.qty_on_hand as number | null) ?? null,
      unit_cost_cents: m?.unit_cost_cents ?? null,
      reorder_point: (row.reorder_point as number | null) ?? null,
      lead_time_days: (row.lead_time_days as number | null) ?? null,
      // bigint/int arrive as strings over PostgREST → coerce.
      reorder_units: Number(row.reorder_units ?? 0),
      reorder_window_days: Number(row.reorder_window_days ?? 0),
    };
  });

  return NextResponse.json({ skus });
}
