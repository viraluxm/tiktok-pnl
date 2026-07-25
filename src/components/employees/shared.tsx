'use client';

import type { EmployeeStatus } from '@/types';

// Shared primitives for the Team/scheduling views (Roster, Recurring Shifts, Time Records,
// Pay). Extracted from the original EmployeesTab so the split views don't duplicate them.

export const inputCls =
  'w-full bg-white/5 border border-tt-border rounded-xl px-4 py-2.5 text-sm text-tt-text focus:outline-none focus:ring-1 focus:ring-tt-cyan/50';

export function fmtHours(h: number): string {
  return `${h.toFixed(2)} hr`;
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-tt-muted uppercase tracking-wide block mb-2">{label}</label>
      {children}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let color = 'bg-tt-muted/15 text-tt-muted';
  if (s === 'active') color = 'bg-tt-green/15 text-tt-green';
  else if (s === 'probation') color = 'bg-tt-yellow/15 text-tt-yellow';
  return (
    <span className={`text-[10px] font-semibold px-2 py-1 rounded-md ${color}`}>{titleCase(status)}</span>
  );
}

export const ROLE_PRESETS = ['host', 'fulfillment', 'manager', 'support', 'other'];
export const STATUSES: EmployeeStatus[] = ['active', 'probation', 'former'];

// Weekdays in Mon–Sun display order, mapped to getUTCDay() numbers (0=Sun … 6=Sat).
export const WEEKDAYS: { label: string; value: number }[] = [
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
  { label: 'Sun', value: 0 },
];

export function daysLabel(days: number[]): string {
  const set = new Set(days);
  const picked = WEEKDAYS.filter((d) => set.has(d.value)).map((d) => d.label);
  return picked.length ? picked.join(', ') : '—';
}
