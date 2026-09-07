import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Employee, ShiftInstance } from '@/types';
import { laTodayISO } from './timezone';
import { weekDatesFor, isValidDateISO } from './schedulePlan';

// "My schedule" for the worker's /s/[token] page: one Mon→Sun week of REAL shift_instances for
// this employee only. No recurring projection, no payroll — a plan row or "Off".
//
// Runs service-role (the public token route never has an auth session), so the employee_id and
// user_id filters ARE the security boundary, exactly like getMyShifts.

export interface WeekScheduleDay {
  date: string; // 'YYYY-MM-DD'
  instance: ShiftInstance | null;
}

export interface WeekSchedule {
  start: string; // Monday
  end: string; // Sunday
  days: WeekScheduleDay[]; // always 7
}

/** Resolve the `?week=` param to a Monday, defaulting to the current LA week on anything odd. */
export function resolveWeekStart(param: string | string[] | undefined, todayISO: string = laTodayISO()): string {
  const raw = Array.isArray(param) ? param[0] : param;
  const anchor = isValidDateISO(raw) ? raw : todayISO;
  return weekDatesFor(anchor)[0];
}

export async function getWeekSchedule(employee: Employee, weekStartISO: string): Promise<WeekSchedule> {
  const admin = createAdminClient();
  const dates = weekDatesFor(weekStartISO);
  const start = dates[0];
  const end = dates[6];

  const { data, error } = await admin
    .from('shift_instances')
    .select('*')
    .eq('employee_id', employee.id)
    .eq('user_id', employee.user_id)
    .in('status', ['scheduled', 'claimed'])
    .gte('shift_date', start)
    .lte('shift_date', end)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`getWeekSchedule: ${error.message}`);

  const byDate = new Map<string, ShiftInstance>();
  for (const row of (data ?? []) as ShiftInstance[]) {
    // UNIQUE(employee_id, shift_date) makes this at most one per day; keep the first defensively.
    if (!byDate.has(row.shift_date)) byDate.set(row.shift_date, row);
  }
  return { start, end, days: dates.map((date) => ({ date, instance: byDate.get(date) ?? null })) };
}
