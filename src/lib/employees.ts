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
