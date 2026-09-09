import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { weekDatesFor, isValidDateISO } from './schedulePlan';

// TEAM SCHEDULE for the worker's own /s/[token] page — REAL shift_instances only.
//
// Deliberately NOT the /s/team/[token] board: that is a separate manager-shared link with its own
// token table, and it still projects recurring rules. This is the employee's in-portal view and is
// instance-only by construction (there is no rules read here at all), which is the Phase 2
// architecture: the visible planned schedule IS shift_instances.
//
// SECURITY. Runs service-role from a public token route, so RLS is bypassed and these filters ARE
// the boundary: the owner comes from the TOKEN-resolved employee, never from a request, and every
// query carries it. The select list is an explicit allow-list of display-safe columns — no
// hourly_rate, no phone, no payroll, no worked hours, no notes, no performance, no tokens.

export interface TeamMemberShift {
  instance_id: string;
  employee_id: string;
  name: string;
  role: string | null;
  starts_at: string;
  ends_at: string;
  /** true when this shift is on the pickup board — it is STILL this person's shift. */
  offered: boolean;
  /** true when this row is the viewer's own shift. */
  is_me: boolean;
}

export interface TeamScheduleDay {
  date: string;
  shifts: TeamMemberShift[];
}

export interface TeamScheduleWeek {
  start: string;
  end: string;
  days: TeamScheduleDay[]; // always 7, Mon→Sun
}

export async function getTeamSchedule(employee: Employee, weekStartISO: string): Promise<TeamScheduleWeek> {
  const admin = createAdminClient();
  const dates = weekDatesFor(weekStartISO);
  const start = dates[0];
  const end = dates[6];

  const { data: rows, error } = await admin
    .from('shift_instances')
    // Explicit allow-list. Never select('*') on a surface an employee can read.
    .select('id, employee_id, shift_date, starts_at, ends_at, status, offer_state, role')
    .eq('user_id', employee.user_id)          // OWNER SCOPE — the tenant boundary
    .in('status', ['scheduled', 'claimed'])   // active planned coverage only
    .not('employee_id', 'is', null)
    .gte('shift_date', start)
    .lte('shift_date', end)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`getTeamSchedule: ${error.message}`);
  const instances = rows ?? [];

  // Names + roles for display only, owner-scoped again so a stray employee_id cannot pull a
  // foreign name into the view.
  const ids = [...new Set(instances.map((r) => r.employee_id as string))];
  const nameById = new Map<string, { name: string; role: string | null }>();
  if (ids.length) {
    const { data: emps, error: eErr } = await admin
      .from('employees')
      .select('id, name, role')
      .eq('user_id', employee.user_id)
      .in('id', ids);
    if (eErr) throw new Error(`getTeamSchedule employees: ${eErr.message}`);
    for (const e of emps ?? []) nameById.set(e.id as string, { name: e.name as string, role: (e.role as string) ?? null });
  }

  const byDate = new Map<string, TeamMemberShift[]>(dates.map((d) => [d, []]));
  for (const r of instances) {
    const bucket = byDate.get(r.shift_date as string);
    if (!bucket) continue;
    const who = nameById.get(r.employee_id as string);
    if (!who) continue; // employee not in this owner's roster → not ours to display
    bucket.push({
      instance_id: r.id as string,
      employee_id: r.employee_id as string,
      name: who.name,
      role: (r.role as string) ?? who.role,
      starts_at: r.starts_at as string,
      ends_at: r.ends_at as string,
      offered: r.offer_state === 'offered',
      is_me: r.employee_id === employee.id,
    });
  }

  return { start, end, days: dates.map((date) => ({ date, shifts: byDate.get(date) ?? [] })) };
}

/**
 * Resolve `?week=` to a Monday, defaulting to the current LA week on anything malformed.
 *
 * Uses schedulePlan's isValidDateISO rather than a local regex + Date.parse: Date.parse happily
 * rolls '2026-02-31' over to March 3rd, so a shape check alone would silently land the viewer on a
 * week they never asked for. isValidDateISO round-trips the parts and rejects it.
 */
export function resolveTeamWeek(param: string | string[] | undefined, todayISO: string = laTodayISO()): string {
  const raw = Array.isArray(param) ? param[0] : param;
  return weekDatesFor(isValidDateISO(raw) ? raw : todayISO)[0];
}
