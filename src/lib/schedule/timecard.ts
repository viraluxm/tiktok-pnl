import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodContaining } from '@/lib/employees';
import type { Employee } from '@/types';
import { laTodayISO } from './timezone';
import { weekBoundsMonSun } from './hours';
import { buildTimecard, timecardReadRange, type OpenEntryRow, type TimecardShiftRow } from './timecardModel';
import type { ClockState, TimecardPayload } from './portalTypes';

// The employee's own timecard for /s/[token] — READ-ONLY.
//
// SECURITY. Runs service-role from a public token route, so RLS is not the boundary: the employee
// comes from the token, and EVERY query carries both `employee_id = me` and `user_id = owner`. The
// select list is an explicit allow-list — `shifts` has no pay column, but this still never reads
// anything the timecard does not render.
//
// WINDOWS. "This week" is the Mon→Sun FLSA week containing today (hours.ts, the same window the
// 40h projection uses). "This pay period" is payPeriodContaining(today) — the period the employee
// is working in right now, which is what the portal's header has always labelled — NOT PayView's
// "period you're next paid for". Both come from employees.ts; nothing here re-derives a calendar.

const SHIFT_COLS =
  'id, employee_id, date, start_time, end_time, source, source_rule_id, confirmed_at, break_minutes, clock_in_at, clock_out_at, auto_closed, approved_minutes';

type Admin = ReturnType<typeof createAdminClient>;

/** The employee's open punch (clocked in, not out), or null. */
export async function getOpenPunch(admin: Admin, employee: Employee): Promise<OpenEntryRow | null> {
  const { data: open, error } = await admin
    .from('employee_time_entries')
    .select('id, clocked_in_at, needs_manual_close')
    .eq('employee_id', employee.id)
    .eq('user_id', employee.user_id)
    .is('clocked_out_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenPunch: ${error.message}`);
  if (!open) return null;
  const { data: br } = await admin
    .from('employee_time_breaks')
    .select('id')
    .eq('time_entry_id', open.id)
    .eq('user_id', employee.user_id)
    .is('ended_at', null)
    .maybeSingle();
  return {
    clocked_in_at: open.clocked_in_at as string,
    on_break: !!br,
    needs_manual_close: !!open.needs_manual_close,
  };
}

export function clockStateOf(open: OpenEntryRow | null): { state: ClockState; clockedInAt: string | null } {
  if (!open) return { state: 'clocked_out', clockedInAt: null };
  return { state: open.on_break ? 'on_break' : 'working', clockedInAt: open.clocked_in_at };
}

export async function getTimecard(employee: Employee, now: Date = new Date()): Promise<TimecardPayload> {
  const admin = createAdminClient();
  const todayISO = laTodayISO(now);
  const week = weekBoundsMonSun(todayISO);
  const period = payPeriodContaining(todayISO);
  const range = timecardReadRange(week, period);

  const [{ data: rows, error }, open] = await Promise.all([
    admin
      .from('shifts')
      .select(SHIFT_COLS)
      .eq('user_id', employee.user_id)
      .eq('employee_id', employee.id)
      .gte('date', range.from)
      .lte('date', range.to)
      .order('date', { ascending: false }),
    getOpenPunch(admin, employee),
  ]);
  if (error) throw new Error(`getTimecard: ${error.message}`);

  return buildTimecard({ shifts: (rows ?? []) as TimecardShiftRow[], open, todayISO, week, period });
}
