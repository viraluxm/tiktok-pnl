import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// GET /api/member/catalog — owner-scoped internal SKU list for the bind picker.
// /api/inventory/skus is gated by org RLS (is_org_member) and members are deliberately NOT in
// organization_members, so that route returns empty for them. This reads the owners' SKUs via
// service_role instead. Returns only { id, sku_number, title, thumbnail_url }.
export async function GET() {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const { data, error } = await admin
    .from('inventory_skus')
    .select('id, sku_number, title, thumbnail_path')
    .in('user_id', ownerIds)
    .order('sku_number', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const skus = (data ?? []).map((row) => {
    const path = (row.thumbnail_path as string | null) ?? null;
    return {
      id: row.id as string,
      sku_number: (row.sku_number as number | null) ?? null,
      title: (row.title as string | null) ?? null,
      thumbnail_url: path ? admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
    };
  });

  return NextResponse.json({ skus });
}
