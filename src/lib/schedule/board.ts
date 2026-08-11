import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodContaining } from '@/lib/employees';
import type { Employee, ShiftInstance } from '@/types';
import { laTodayISO } from './timezone';
import { computeDrops, type DropSummary } from './drops';
import { effectiveShiftRole } from './eligibility';

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

// This viewer's PENDING claims (OT gate — awaiting a manager). Shown as its own "Pending approval"
// section on /s so the claimer sees the request is in-flight and NOT yet theirs. Once the manager
// acts, the claim leaves 'pending' (approved → the instance flips to claimed and shows under Your
// shifts; rejected → it drops off here and the instance returns to the board), so this list is the
// live state of anything awaiting a decision.
export interface PendingClaimView {
  claim_id: string;
  starts_at: string;
  ends_at: string;
  shift_date: string;
  projected_week_hours: number | null;
}
export async function getMyPendingClaims(employee: Employee): Promise<PendingClaimView[]> {
  const admin = createAdminClient();
  const { data: claims, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id, projected_week_hours')
    .eq('claimed_by', employee.id)
    .eq('status', 'pending')
    .order('claimed_at', { ascending: true });
  if (error) throw new Error(`getMyPendingClaims: ${error.message}`);
  const rows = claims ?? [];
  if (rows.length === 0) return [];

  const instIds = [...new Set(rows.map((r) => r.shift_instance_id))];
  const { data: insts, error: iErr } = await admin
    .from('shift_instances')
    .select('id, starts_at, ends_at, shift_date')
    .in('id', instIds);
  if (iErr) throw new Error(`getMyPendingClaims instances: ${iErr.message}`);
  const byId = new Map((insts ?? []).map((i) => [i.id, i]));
  return rows
    .map((r) => {
      const i = byId.get(r.shift_instance_id);
      if (!i) return null;
      return {
        claim_id: r.id,
        starts_at: i.starts_at,
        ends_at: i.ends_at,
        shift_date: i.shift_date,
        projected_week_hours: r.projected_week_hours,
      };
    })
    .filter((x): x is PendingClaimView => x !== null);
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

  // Not-my-own-release. Admin-posted open shifts have released_by NULL — keep them (null !== me).
  candidates = candidates.filter((c) => c.released_by !== employee.id);
  if (candidates.length === 0) return [];

  // Hide shifts this viewer already has a PENDING claim on — the instance is still 'released' (so
  // it stays on the board for everyone else), but for the claimer it now lives in their "Pending
  // approval" section, not back on the board. Prevents a double-claim on the same instance.
  const { data: myPending, error: mpErr } = await admin
    .from('shift_claims')
    .select('shift_instance_id')
    .eq('claimed_by', employee.id)
    .eq('status', 'pending');
  if (mpErr) throw new Error(`getBoard myPending: ${mpErr.message}`);
  const pendingIds = new Set((myPending ?? []).map((r) => r.shift_instance_id as string));
  if (pendingIds.size) candidates = candidates.filter((c) => !pendingIds.has(c.id));
  if (candidates.length === 0) return [];

  // Resolve the releaser's name/role for released shifts. Role for an admin_open shift (no
  // releaser) comes from the row's own `role` column (migration 090).
  const releaserIds = [...new Set(candidates.map((c) => c.released_by).filter(Boolean) as string[])];
  const relById = new Map<string, { id: string; name: string; role: string }>();
  if (releaserIds.length) {
    const { data: releasers, error: relErr } = await admin
      .from('employees')
      .select('id, name, role')
      .in('id', releaserIds);
    if (relErr) throw new Error(`getBoard releasers: ${relErr.message}`);
    for (const r of releasers ?? []) relById.set(r.id, r);
  }
  const effectiveRole = (c: ShiftInstance) =>
    effectiveShiftRole(c, c.released_by ? relById.get(c.released_by)?.role ?? null : null);

  // Keep only shifts whose role matches the viewer.
  candidates = candidates.filter((c) => effectiveRole(c) === employee.role);
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
    .map((c) => ({
      ...c,
      releaser_name: c.released_by ? relById.get(c.released_by)?.name ?? null : null,
      releaser_role: effectiveRole(c),
    }));
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
