import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { computeDrops } from '@/lib/schedule/drops';
import { payPeriodContaining } from '@/lib/employees';
import { laTodayISO } from '@/lib/schedule/timezone';

export const dynamic = 'force-dynamic';

// GET /api/member/team/attendance — owner-WIDE adaptation of src/lib/schedule/board.ts's
// getCurrentPeriodDrops (which is per-employee): the current pay period + each employee's drop
// summary within it. Explicit columns (employee_id, event_type, shift_date) — never select('*').
// attendance_events carries no pay field. Read-only.
export async function GET() {
  const scope = await requireMemberScope('team');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  const period = payPeriodContaining(laTodayISO());
  const { data, error } = await admin
    .from('attendance_events')
    .select('employee_id, event_type, shift_date')
    .in('user_id', ownerIds)
    .eq('pay_period_start', period.start);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by employee, then run the shared drop computation per employee.
  const byEmp = new Map<string, { event_type: string; shift_date: string }[]>();
  for (const r of (data ?? []) as Array<{ employee_id: string; event_type: string; shift_date: string }>) {
    const eid = String(r.employee_id);
    if (!byEmp.has(eid)) byEmp.set(eid, []);
    byEmp.get(eid)!.push({ event_type: r.event_type, shift_date: r.shift_date });
  }
  const drops = [...byEmp.entries()].map(([employee_id, events]) => ({
    employee_id,
    ...computeDrops(events as Parameters<typeof computeDrops>[0]),
  }));
  return NextResponse.json({ period, drops });
}
