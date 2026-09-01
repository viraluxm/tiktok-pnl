import { notFound } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOwnerByScheduleToken } from '@/lib/schedule/teamScheduleToken';
import { laWallClockOf, laTodayISO } from '@/lib/schedule/timezone';
import { generateRecurringShifts } from '@/lib/employees';
import type { ShiftRule, ShiftException } from '@/types';
import { monthGridDays, startOfMonthISO } from '@/lib/weeklySchedule';
import TeamScheduleBoard, { type PublicShift } from './TeamScheduleBoard';

export const dynamic = 'force-dynamic';

// PUBLIC read-only team schedule. Deliberately a SERVER component that fetches with the
// service-role client and hands plain data to a client component — there is no Supabase client
// in the browser here, so this page can never establish an auth session (CLAUDE.md: a session on
// a host machine clobbers the capture extension's JWT). `/s/` is excluded from the middleware
// matcher, so updateSession never runs for it either.
//
// What this exposes: names, roles, and SCHEDULED spans. Deliberately NOT punches, hours worked,
// hourly rate, or pay — a link that can be forwarded must not carry payroll.

export default async function TeamSchedulePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ownerId = await resolveOwnerByScheduleToken(token);
  if (!ownerId) notFound(); // unknown / revoked / malformed are indistinguishable

  const today = laTodayISO();
  // Load the current month plus the next one — a fortnightly schedule usually straddles the edge.
  const thisGrid = monthGridDays(startOfMonthISO(today));
  const rangeStart = thisGrid.gridStart;
  const rangeEnd = monthGridDays(startOfMonthISO(addMonths(today, 2))).gridEnd;

  const admin = createAdminClient();

  // EVERY query is filtered by the owner resolved from the token. Service-role bypasses RLS, so
  // this explicit filter is the security boundary.
  const [{ data: instances }, { data: employees }, { data: rules }, { data: exceptions }] = await Promise.all([
    admin
      .from('shift_instances')
      .select('id, employee_id, shift_date, starts_at, ends_at, status, released_at, role')
      .eq('user_id', ownerId)
      .gte('shift_date', rangeStart)
      .lte('shift_date', rangeEnd)
      .order('shift_date', { ascending: true }),
    admin
      .from('employees')
      // Name + role ONLY. Never hourly_rate, never phone.
      .select('id, name, role, status')
      .eq('user_id', ownerId),
    // Most of the schedule is still recurring RULES, not materialized instances (the forward
    // materializer stopped in Aug 2026). Reading instances alone left this link almost empty
    // past the first week, so project the rules here exactly as the admin calendar does.
    admin.from('shift_rules').select('*').eq('user_id', ownerId).eq('active', true),
    admin.from('shift_exceptions').select('*').eq('user_id', ownerId),
  ]);

  const nameById = new Map((employees ?? []).map((e) => [e.id as string, e]));

  const shifts: PublicShift[] = [];
  for (const i of instances ?? []) {
    if (!i.employee_id || i.released_at) continue;
    if (i.status !== 'scheduled' && i.status !== 'claimed' && i.status !== 'worked') continue;
    const emp = nameById.get(i.employee_id as string);
    if (!emp) continue;
    shifts.push({
      id: String(i.id),
      employee_id: String(i.employee_id),
      name: String(emp.name),
      role: (emp.role as string | null) ?? null,
      date: String(i.shift_date),
      start_time: laWallClockOf(i.starts_at as string).time,
      end_time: laWallClockOf(i.ends_at as string).time,
    });
  }

  // Rule projections, minus any day already frozen into a real instance, so a materialized day
  // is not counted twice.
  const takenByInstance = new Set(shifts.map((s) => `${s.employee_id}|${s.date}`));
  for (const g of generateRecurringShifts(
    (rules ?? []) as ShiftRule[],
    (exceptions ?? []) as ShiftException[],
    rangeStart,
    rangeEnd,
    new Set(),
  )) {
    if (g.skipped) continue;
    if (takenByInstance.has(`${g.employee_id}|${g.date}`)) continue;
    const emp = nameById.get(g.employee_id);
    if (!emp) continue;
    shifts.push({
      id: g.id,
      employee_id: g.employee_id,
      name: String(emp.name),
      role: (emp.role as string | null) ?? null,
      date: g.date,
      start_time: g.start_time,
      end_time: g.end_time,
    });
  }

  return <TeamScheduleBoard shifts={shifts} todayISO={today} monthsAhead={2} />;
}

// Local helper — the month grid needs an anchor two months out for the range end.
function addMonths(iso: string, n: number): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
