import { NextResponse } from 'next/server';
import { requireMember } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/stores — the member's assigned stores as { id, name }. Shared by every member
// scope (binding's store-filter pills, inventory, …), so it uses requireMember (any member) rather
// than a specific scope; the middleware allowlist already restricts the path to scopes that grant
// it. storeIds is the resolved assignment: an all-stores member gets ALL owner stores, a
// store-restricted member gets only theirs — so this never leaks a store outside the member's scope.
export async function GET() {
  const scope = await requireMember();
  if (!scope.ok) return scope.response;
  const { admin, storeIds } = scope;
  if (!storeIds.length) return NextResponse.json({ stores: [] });

  const { data, error } = await admin
    .from('stores')
    .select('id, name')
    .in('id', storeIds)
    .order('name', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stores = (data ?? []).map((r) => ({ id: r.id as string, name: (r.name as string | null) ?? null }));
  return NextResponse.json({ stores });
}
