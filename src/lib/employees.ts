import type { Employee, Shift } from '@/types';

// Minutes since midnight for an 'HH:MM' / 'HH:MM:SS' time string.
function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Hours worked for a single shift, derived from its time range. A shift whose end is
// before its start is treated as running past midnight (end rolls into the next day).
export function shiftHours(startTime: string, endTime: string): number {
  let mins = parseTime(endTime) - parseTime(startTime);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

export interface EmployeePay {
  employee: Employee;
  hours: number;
  pay: number; // hours * hourly_rate — derived, never stored
}

// Per-employee hours + derived pay owed for the given set of shifts (already scoped to
// the pay period by the caller).
export function computePay(employees: Employee[], shifts: Shift[]): EmployeePay[] {
  const hoursByEmployee = new Map<string, number>();
  for (const s of shifts) {
    const prev = hoursByEmployee.get(s.employee_id) || 0;
    hoursByEmployee.set(s.employee_id, prev + shiftHours(s.start_time, s.end_time));
  }
  return employees.map((employee) => {
    const hours = hoursByEmployee.get(employee.id) || 0;
    return { employee, hours, pay: hours * employee.hourly_rate };
  });
}

const DAY_MS = 86_400_000;
const FRIDAY = 5; // getUTCDay(): Sun=0 … Fri=5 … Sat=6

// Parse a 'YYYY-MM-DD' date as UTC midnight. Working purely in UTC-midnight space keeps
// the weekday/step math free of local-timezone and DST drift.
function parseDateUTC(d: string): Date {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

// The employee's NEXT upcoming biweekly payday relative to `today`, anchored to
// hire_date. Rules: paydays fall on Fridays; the first payday is the SECOND Friday
// after hire_date; then every 14 days. Friday-hire edge case — the hire day itself
// does not count, so the next Friday is the "1st Friday" (handled by taking the first
// Friday STRICTLY after hire_date). Returns a formatted date like "Fri, Jul 17", or
// null when hire_date is missing/unparseable.
export function nextPayday(hireDate: string | null, today: Date = new Date()): string | null {
  if (!hireDate) return null;
  const hire = parseDateUTC(hireDate);
  if (isNaN(hire.getTime())) return null;

  // 1st Friday strictly after hire_date (a Friday hire rolls forward a full week).
  const daysToFirstFriday = ((FRIDAY - hire.getUTCDay() + 7) % 7) || 7;
  const firstFriday = addDaysUTC(hire, daysToFirstFriday);
  // First payday = 2nd Friday = 1st Friday + 7 days.
  const firstPayday = addDaysUTC(firstFriday, 7);

  // Compare at day granularity using the local calendar date the user sees as "today".
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

  // Advance in 14-day steps to the first payday that is today or later.
  let payday = firstPayday;
  if (payday.getTime() < todayUTC.getTime()) {
    const periods = Math.ceil((todayUTC.getTime() - payday.getTime()) / (14 * DAY_MS));
    payday = addDaysUTC(payday, periods * 14);
  }

  return payday.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
