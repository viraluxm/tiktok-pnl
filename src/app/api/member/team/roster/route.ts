import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/team/roster — owner-scoped employee roster for the member 'team' scope.
// EXPLICIT column list, NEVER select('*') — employees.hourly_rate is deliberately OMITTED (no pay
// in this scope). Read-only.
export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const { data, error } = await admin
    .from('employees')
    .select('id, name, role, status, hire_date, probation_end_date, store_id')
    .in('user_id', ownerIds)
    .order('name', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ employees: data ?? [] });
}
