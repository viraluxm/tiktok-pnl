import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/station/employees — the picker roster for the station: the store owners' employees
// that are active/probation AND role 'fulfillment' (matched case-insensitively, since role is
// free text). Returns only { id, name }. Service_role, gated on app_metadata.role === 'station'.
export async function GET() {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;

  const { data, error } = await scope.admin
    .from('employees')
    .select('id, name, role, status')
    .in('user_id', scope.ownerIds)
    .in('status', ['active', 'probation']);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const employees = (data ?? [])
    .filter((e) => (e.role as string | null ?? '').trim().toLowerCase() === 'fulfillment')
    .map((e) => ({ id: e.id as string, name: e.name as string }));

  return NextResponse.json({ employees });
}
