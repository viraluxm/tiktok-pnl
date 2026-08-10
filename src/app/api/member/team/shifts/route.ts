import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/team/shifts — owner-scoped schedule for the member 'team' scope: recurring rules,
// generated instances, and time-clock shifts. Hours are computed client-side from the times; these
// tables carry NO pay field, but all reads use EXPLICIT column lists (never select('*')). Read-only.
export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const [inst, rules, sh] = await Promise.all([
    admin.from('shift_instances')
      .select('id, employee_id, store_id, shift_date, starts_at, ends_at, status, source, released_by, released_at, shift_rule_id')
      .in('user_id', ownerIds)
      .order('starts_at', { ascending: true }),
    admin.from('shift_rules')
      .select('id, employee_id, days_of_week, start_time, end_time, start_date, active, store_id')
      .in('user_id', ownerIds),
    admin.from('shifts')
      .select('id, employee_id, date, start_time, end_time, store_id, source, confirmed_at, break_minutes, auto_closed')
      .in('user_id', ownerIds)
      .order('date', { ascending: false })
      .limit(500),
  ]);
  const err = inst.error || rules.error || sh.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({
    shift_instances: inst.data ?? [],
    shift_rules: rules.data ?? [],
    shifts: sh.data ?? [],
  });
}
