import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodContaining } from '@/lib/employees';
import type { Employee, ShiftInstance } from '@/types';
import { laTodayISO } from './timezone';
import { computeDrops, type DropSummary } from './drops';

// 24h notice window — a shift may only be released/claimed while it starts MORE than 24h out.
export const NOTICE_MS = 24 * 60 * 60 * 1000;
const FILLING = ['scheduled', 'claimed'];

// A board row with the releaser resolved (migration 086: role comes from employees.role, not a
// template). released_by is the original person; both name and role are looked up from them.
export interface BoardRow extends ShiftInstance {
  releaser_name: string | null;
  releaser_role: string | null;
}

// "Your shifts" — the next 14 days for this employee: the instances they're assigned
// (employee_id = them, scheduled/claimed) PLUS the ones they released and are awaiting pickup
// (released_by = them, status 'released' — where employee_id is now NULL). Ordered by start.
// Role for display is the viewer's own employees.role (their shift).
export async function getMyShifts(employee: Employee): Promise<ShiftInstance[]> {
  const admin = createAdminClient();
  const today = laTodayISO();
  const horizonEnd = addDays(today, 14);

  const [assigned, releasedByMe] = await Promise.all([
    admin
      .from('shift_instances')
      .select('*')
      .eq('employee_id', employee.id)
      .in('status', ['scheduled', 'claimed'])
      .gte('shift_date', today)
      .lte('shift_date', horizonEnd)
      .order('starts_at', { ascending: true }),
    admin
      .from('shift_instances')
      .select('*')
      .eq('released_by', employee.id)
      .eq('status', 'released')
      .gte('shift_date', today)
      .lte('shift_date', horizonEnd)
      .order('starts_at', { ascending: true }),
  ]);
  if (assigned.error) throw new Error(`getMyShifts assigned: ${assigned.error.message}`);
  if (releasedByMe.error) throw new Error(`getMyShifts released: ${releasedByMe.error.message}`);

  const rows = [...(assigned.data ?? []), ...(releasedByMe.data ?? [])] as ShiftInstance[];
  return rows.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
}

// Does this employee have any active recurring rule? Drives the "no schedule set yet" empty state
// on /s (a token with no rules is valid — it just has nothing scheduled).
export async function hasActiveRules(employee: Employee): Promise<boolean> {
  const { count, error } = await createAdminClient()
    .from('shift_rules')
    .select('id', { count: 'exact', head: true })
    .eq('employee_id', employee.id)
    .eq('active', true);
  if (error) throw new Error(`hasActiveRules: ${error.message}`);
  return (count ?? 0) > 0;
}

// Whether a given instance is releasable by its owner right now (scheduled + >24h out).
export function isReleasable(inst: Pick<ShiftInstance, 'status' | 'starts_at'>, now = new Date()): boolean {
  return inst.status === 'scheduled' && new Date(inst.starts_at).getTime() > now.getTime() + NOTICE_MS;
}

// The BOARD — released instances this viewer is eligible to claim. EVERY eligibility condition is
// enforced HERE (server-side); we never render a row that a claim would reject. Role now comes from
// the RELEASER's employees.role (no template). No capacity condition — one released instance is one
// person's shift.
export async function getBoard(employee: Employee, now = new Date()): Promise<BoardRow[]> {
  const admin = createAdminClient();
  const thresholdISO = new Date(now.getTime() + NOTICE_MS).toISOString();

  const { data, error } = await admin
    .from('shift_instances')
    .select('*')
    .eq('status', 'released')
    .gt('starts_at', thresholdISO)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`getBoard released: ${error.message}`);
  let candidates = (data ?? []) as ShiftInstance[];

  // Not-my-own-release.
  candidates = candidates.filter((c) => c.released_by && c.released_by !== employee.id);
  if (candidates.length === 0) return [];

  // Resolve releaser role + name; keep only shifts whose (releaser's) role matches the viewer.
  const releaserIds = [...new Set(candidates.map((c) => c.released_by as string))];
  const { data: releasers, error: relErr } = await admin
    .from('employees')
    .select('id, name, role')
    .in('id', releaserIds);
  if (relErr) throw new Error(`getBoard releasers: ${relErr.message}`);
  const relById = new Map((releasers ?? []).map((r) => [r.id, r]));
  candidates = candidates.filter((c) => relById.get(c.released_by as string)?.role === employee.role);
  if (candidates.length === 0) return [];

  // Viewer already has an active instance that day → not eligible (no double-booking).
  const { data: mine, error: mErr } = await admin
    .from('shift_instances')
    .select('shift_date')
    .eq('employee_id', employee.id)
    .in('status', FILLING);
  if (mErr) throw new Error(`getBoard mine: ${mErr.message}`);
  const myDates = new Set((mine ?? []).map((r) => r.shift_date as string));

  return candidates
    .filter((c) => !myDates.has(c.shift_date))
    .map((c) => {
      const rel = relById.get(c.released_by as string);
      return { ...c, releaser_name: rel?.name ?? null, releaser_role: rel?.role ?? null };
    });
}

// Current pay period (containing today) + this employee's drop summary for it. The employee-facing
// header labels THIS window's end — distinct from PayView's "period you're next paid for".
export async function getCurrentPeriodDrops(
  employee: Employee,
): Promise<{ period: { start: string; end: string }; drops: DropSummary }> {
  const admin = createAdminClient();
  const period = payPeriodContaining(laTodayISO());
  const { data, error } = await admin
    .from('attendance_events')
    .select('event_type, shift_date')
    .eq('employee_id', employee.id)
    .eq('pay_period_start', period.start);
  if (error) throw new Error(`getCurrentPeriodDrops: ${error.message}`);
  return { period, drops: computeDrops(data ?? []) };
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
