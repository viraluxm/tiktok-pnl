import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/team/shifts — owner-scoped schedule for the member 'team' scope: real
// shift_instances plus time-clock `shifts`. Hours are computed client-side from the times; these
// tables carry NO pay field, but all reads use EXPLICIT column lists (never select('*')). Read-only.
//
// NO shift_rules. It used to also return every active recurring rule, which the ONLY caller
// ((station)/team/staff) never read — it destructures `shift_instances` and `shifts` and drops the
// rest. So the rules were fetched, serialised and thrown away on every request, while keeping a
// recurring-projection data source alive on a schedule surface that should be instance-only.
//
// This is a MANAGER surface, not the employee team schedule, so statuses are deliberately NOT
// filtered: the table renders each instance's status in its own column and a manager is meant to
// see cancelled/worked rows too.
export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const [inst, sh] = await Promise.all([
    admin.from('shift_instances')
      .select('id, employee_id, store_id, shift_date, starts_at, ends_at, status, source, released_by, released_at, shift_rule_id')
      .in('user_id', ownerIds)
      .order('starts_at', { ascending: true }),
    admin.from('shifts')
      // EVERY field toTimecardEntry reads, and for a reason each:
      //   source_rule_id — a materialized PLAN row is not worked time and must be dropped, not counted
      //   clock_in_at / clock_out_at — the punch instants ARE the clocked duration; deriving hours from
      //     the wall clock instead is what made this page disagree with payroll (and omitting the
      //     instants from a projection is the same defect that produced the diverged rows in #170)
      //   approved_minutes — migration 137: the manager-approved figure WINS over the clocked span
      // Still no pay column: hours are a duration, never a rate or an amount.
      .select('id, employee_id, date, start_time, end_time, store_id, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at, auto_closed, approved_minutes')
      .in('user_id', ownerIds)
      .order('date', { ascending: false })
      .limit(500),
  ]);
  const err = inst.error || sh.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({
    shift_instances: inst.data ?? [],
    shifts: sh.data ?? [],
  });
}
