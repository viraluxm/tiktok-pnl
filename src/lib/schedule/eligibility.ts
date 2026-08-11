// Pure scheduling-eligibility kernels — NO imports (server-safe, and unit-testable via the
// runtime-transpile pattern the other schedule tests use). The DB-bound orchestration in board.ts /
// claim.ts / adminShifts.ts calls into these so the two read paths can never disagree on what role
// a shift represents.

// The pay-role a released/open shift represents:
//   • released shift (released_by set) → the RELEASER's role (derived; the row carries no role)
//   • admin one-time open shift (source 'admin_open', no releaser) → the row's OWN `role` (mig 090)
//   • anything else → null (malformed for the board — not claimable)
// `releaserRole` is the looked-up employees.role of released_by (null when there's no releaser or it
// couldn't be resolved).
export function effectiveShiftRole(
  inst: { released_by: string | null; source: string; role?: string | null },
  releaserRole: string | null,
): string | null {
  if (inst.released_by) return releaserRole;
  if (inst.source === 'admin_open') return inst.role ?? null;
  return null;
}

export type AdminShiftPlan =
  | { ok: true; status: 'scheduled' | 'released'; role: string }
  | { ok: false; error: 'ROLE_REQUIRED' };

// Decide status + role for a one-time admin shift.
//   • assigned (employeeRole given) → status 'scheduled' (lands on the person's schedule); role is
//     the employee's own role, so any typed role input is ignored (no mismatch possible).
//   • unassigned → status 'released' (straight to the board); role is REQUIRED here and must be a
//     valid pay-role class, since there's no employee to derive it from (migration 090 header).
export function planAdminShift(input: {
  employeeRole: string | null; // the assigned employee's role, or null when unassigned
  role: string | null; // the typed role field (only consulted when unassigned)
}): AdminShiftPlan {
  if (input.employeeRole) return { ok: true, status: 'scheduled', role: input.employeeRole };
  if (input.role === 'host' || input.role === 'fulfillment') return { ok: true, status: 'released', role: input.role };
  return { ok: false, error: 'ROLE_REQUIRED' };
}

// Does an admin shift's [start,end) cross midnight (end on the NEXT calendar day)? Times are
// 'HH:MM' wall-clock. end <= start means overnight (end rolls to +1 day); end === start is caller-
// rejected as zero-length before this is used.
export function crossesMidnight(startHHMM: string, endHHMM: string): boolean {
  return toMins(endHHMM) <= toMins(startHHMM);
}

function toMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
