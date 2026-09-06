// Pure kernels for the Phase 2 offer lifecycle: Drop Shift, Available Shifts, Pick Up Shift.
//
// NO value imports beyond the import-free helper modules, so this transpiles standalone for the
// runtime-transpile tests the rest of src/lib/schedule uses. Everything DB-bound lives in offer.ts.
//
// THE PRODUCT RULE these kernels exist to protect:
//   Dropping a shift OFFERS it. It does NOT hand it back. The original employee stays assigned,
//   stays visible on every schedule, and stays clock-eligible until a manager approves someone
//   else. That is why the offer lifecycle is a separate axis from `status` and never touches
//   employee_id or released_at (migration 129).

import { isClockEligibleStatus } from './eligibility';

export type OfferState = 'offered' | 'transferred' | 'closed' | null | undefined;

/** The subset of a shift_instances row these kernels reason about. */
export interface OfferableInstance {
  id: string;
  user_id: string;
  employee_id: string | null;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: string;
  released_at: string | null;
  released_by: string | null;
  role: string | null;
  source: string;
  offer_state?: OfferState;
  offer_id?: string | null;
}

// ── Drop Shift ────────────────────────────────────────────────────────────────────────────────

export type DropRefusal =
  | 'NOT_YOUR_SHIFT'
  | 'PAST_SHIFT'
  | 'ALREADY_STARTED'
  | 'NOT_ACTIVE'
  | 'ALREADY_OFFERED'
  | 'OFFER_CLOSED'
  | 'RELEASED_LEGACY';

export const DROP_REFUSAL_MESSAGES: Record<DropRefusal, string> = {
  NOT_YOUR_SHIFT: 'That shift is not yours to drop.',
  PAST_SHIFT: 'That shift has already passed.',
  ALREADY_STARTED: 'That shift has already started.',
  NOT_ACTIVE: 'That shift is no longer on your schedule.',
  ALREADY_OFFERED: 'You have already offered this shift to your coworkers.',
  OFFER_CLOSED: 'This shift has already been picked up.',
  RELEASED_LEGACY: 'This shift is already on the old open-shift board — contact a manager.',
};

export type DropPlan = { ok: true } | { ok: false; code: DropRefusal };

/**
 * Can this employee offer this shift right now?
 *
 * Deliberately does NOT consult the drop cap. Blocking a drop produces a no-show, which is worse
 * than an over-cap drop — the same reasoning release.ts records, and the cap stays a warning the
 * UI surfaces on the confirm step. The cap still COUNTS: an offer that completes writes the same
 * 'released' attendance_event the legacy path does (see offer.ts).
 */
export function planDrop(input: {
  inst: OfferableInstance;
  employeeId: string;
  nowMs: number;
  todayISO: string;
}): DropPlan {
  const i = input.inst;
  if (i.employee_id !== input.employeeId) return { ok: false, code: 'NOT_YOUR_SHIFT' };
  // A legacy released row is unowned by definition, so it cannot also be "still yours".
  if (i.released_at) return { ok: false, code: 'RELEASED_LEGACY' };
  if (!isClockEligibleStatus(i.status)) return { ok: false, code: 'NOT_ACTIVE' };
  if (i.shift_date < input.todayISO) return { ok: false, code: 'PAST_SHIFT' };
  const startsMs = Date.parse(i.starts_at);
  if (!Number.isFinite(startsMs) || startsMs <= input.nowMs) return { ok: false, code: 'ALREADY_STARTED' };
  if (i.offer_state === 'offered') return { ok: false, code: 'ALREADY_OFFERED' };
  if (i.offer_state === 'transferred') return { ok: false, code: 'OFFER_CLOSED' };
  // 'closed' is re-offerable: an offer that ended without a transfer leaves the shift ours.
  return { ok: true };
}

// ── Pick Up Shift ─────────────────────────────────────────────────────────────────────────────

export type PickupRefusal =
  | 'NOT_OFFERED'
  | 'STALE_OFFER'
  | 'OWN_SHIFT'
  | 'WRONG_ROLE'
  | 'ALREADY_SCHEDULED_THAT_DAY'
  | 'ALREADY_REQUESTED'
  | 'PAST_SHIFT'
  | 'ALREADY_STARTED'
  | 'INACTIVE_EMPLOYEE';

export const PICKUP_REFUSAL_MESSAGES: Record<PickupRefusal, string> = {
  NOT_OFFERED: 'This shift is no longer available.',
  STALE_OFFER: 'This shift was re-offered — refresh to see the current version.',
  OWN_SHIFT: 'This is your own shift.',
  WRONG_ROLE: 'This shift is for a different role.',
  ALREADY_SCHEDULED_THAT_DAY: "You're already scheduled that day.",
  ALREADY_REQUESTED: 'Pickup requested',
  PAST_SHIFT: 'That shift has already passed.',
  ALREADY_STARTED: 'That shift has already started.',
  INACTIVE_EMPLOYEE: 'Your account is not active.',
};

export type PickupPlan = { ok: true } | { ok: false; code: PickupRefusal };

/**
 * Can this employee request to pick up this offer?
 *
 * `expectedOfferId` is the id the CLIENT was looking at. It must match the row's current offer_id,
 * so a request fired against a stale board never lands on a newer offer cycle (the ABA guard).
 */
export function planPickup(input: {
  inst: OfferableInstance;
  employeeId: string;
  employeeRole: string | null;
  employeeStatus: string;
  expectedOfferId?: string | null;
  myDatesInUse: ReadonlySet<string>;
  alreadyRequested: boolean;
  nowMs: number;
  todayISO: string;
}): PickupPlan {
  const i = input.inst;
  if (input.employeeStatus !== 'active') return { ok: false, code: 'INACTIVE_EMPLOYEE' };
  if (i.offer_state !== 'offered' || !i.offer_id) return { ok: false, code: 'NOT_OFFERED' };
  if (input.expectedOfferId && input.expectedOfferId !== i.offer_id) return { ok: false, code: 'STALE_OFFER' };
  if (i.employee_id === input.employeeId) return { ok: false, code: 'OWN_SHIFT' };
  if (i.shift_date < input.todayISO) return { ok: false, code: 'PAST_SHIFT' };
  const startsMs = Date.parse(i.starts_at);
  if (!Number.isFinite(startsMs) || startsMs <= input.nowMs) return { ok: false, code: 'ALREADY_STARTED' };
  if (offerRole(i) !== input.employeeRole) return { ok: false, code: 'WRONG_ROLE' };
  if (input.alreadyRequested) return { ok: false, code: 'ALREADY_REQUESTED' };
  if (input.myDatesInUse.has(i.shift_date)) return { ok: false, code: 'ALREADY_SCHEDULED_THAT_DAY' };
  return { ok: true };
}

/**
 * The role an offered shift represents. An offered shift is STILL ASSIGNED, so unlike the legacy
 * board (where the role had to be derived from the releaser because employee_id was null) the role
 * comes straight from the row's own `role`, falling back to the assignee's role supplied by the
 * caller. Kept as a named kernel so the board and the request path can never disagree.
 */
export function offerRole(i: Pick<OfferableInstance, 'role'>, assigneeRole?: string | null): string | null {
  return i.role ?? assigneeRole ?? null;
}

// ── Available Shifts board ────────────────────────────────────────────────────────────────────

export interface AvailableShift {
  id: string;
  offer_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  role: string | null;
  offered_by_name: string | null;
  /** null when the viewer may request it; otherwise why not, for a disabled control. */
  refusal: PickupRefusal | null;
}

/**
 * Shape every live offer for the viewer, annotating each with whether THEY can take it.
 *
 * Ineligible offers are returned annotated rather than dropped, except the viewer's own shift —
 * seeing "you're already scheduled that day" is more useful than a mysteriously short list, but
 * seeing your own dropped shift under "Available" would be confusing since it already appears
 * under My Schedule marked as offered.
 */
export function buildAvailableShifts(input: {
  offers: OfferableInstance[];
  assigneeRoleById: ReadonlyMap<string, string | null>;
  assigneeNameById: ReadonlyMap<string, string | null>;
  employeeId: string;
  employeeRole: string | null;
  employeeStatus: string;
  myDatesInUse: ReadonlySet<string>;
  requestedInstanceIds: ReadonlySet<string>;
  nowMs: number;
  todayISO: string;
}): AvailableShift[] {
  const out: AvailableShift[] = [];
  for (const i of input.offers) {
    if (i.employee_id === input.employeeId) continue; // own shift — shown under My Schedule instead
    const plan = planPickup({
      inst: i,
      employeeId: input.employeeId,
      employeeRole: input.employeeRole,
      employeeStatus: input.employeeStatus,
      myDatesInUse: input.myDatesInUse,
      alreadyRequested: input.requestedInstanceIds.has(i.id),
      nowMs: input.nowMs,
      todayISO: input.todayISO,
    });
    // A role mismatch is not "unavailable to you", it is someone else's job — hide it entirely.
    if (!plan.ok && plan.code === 'WRONG_ROLE') continue;
    if (!plan.ok && (plan.code === 'NOT_OFFERED' || plan.code === 'PAST_SHIFT' || plan.code === 'ALREADY_STARTED')) continue;
    out.push({
      id: i.id,
      offer_id: i.offer_id as string,
      shift_date: i.shift_date,
      starts_at: i.starts_at,
      ends_at: i.ends_at,
      role: offerRole(i, i.employee_id ? input.assigneeRoleById.get(i.employee_id) ?? null : null),
      offered_by_name: i.employee_id ? input.assigneeNameById.get(i.employee_id) ?? null : null,
      refusal: plan.ok ? null : plan.code,
    });
  }
  return out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
}
