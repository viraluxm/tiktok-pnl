// Pure kernels for the one-for-one SHIFT TRADE (v1). No value imports beyond the import-free
// eligibility module, so this transpiles standalone for the runtime-transpile tests.
//
// THE RULE these kernels protect: a trade NEVER moves a shift by itself. It is a proposal
// (pending_coworker) → an agreement (pending_manager) → a manager's approval, and only the approval
// RPC (lensed_approve_shift_trade, migration 136) changes ownership, atomically, after re-checking
// everything below against the live rows. Everything here is the pre-check that keeps obviously
// impossible proposals out of the queue; the RPC is the authority.

import { isClockEligibleStatus } from './eligibility';

export interface TradeableInstance {
  id: string;
  user_id: string;
  employee_id: string | null;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: string;
  released_at: string | null;
  role: string | null;
  offer_state?: 'offered' | 'transferred' | 'closed' | null;
}

export interface TradeParty {
  id: string;
  role: string | null;
  status: string; // 'active' | 'probation' | 'former'
}

export type TradeRefusal =
  | 'NOT_YOUR_SHIFT'
  | 'SHIFT_NOT_ACTIVE'
  | 'SHIFT_RELEASED'
  | 'SHIFT_OFFERED'
  | 'ALREADY_STARTED'
  | 'SAME_SHIFT'
  | 'SAME_EMPLOYEE'
  | 'CROSS_OWNER'
  | 'TARGET_NOT_OWNED'
  | 'ROLE_MISMATCH'
  | 'IN_ACTIVE_TRADE'
  | 'REQUESTER_DOUBLE_BOOKED'
  | 'TARGET_DOUBLE_BOOKED'
  | 'INACTIVE_EMPLOYEE';

export const TRADE_REFUSAL_MESSAGES: Record<TradeRefusal, string> = {
  NOT_YOUR_SHIFT: 'That shift is not yours to trade.',
  SHIFT_NOT_ACTIVE: 'That shift is no longer on the schedule.',
  SHIFT_RELEASED: 'That shift is on the open-shift board and cannot be traded.',
  SHIFT_OFFERED: 'Cancel the offer on this shift before trading it.',
  ALREADY_STARTED: 'That shift has already started.',
  SAME_SHIFT: 'Pick a different shift to trade for.',
  SAME_EMPLOYEE: 'You cannot trade with yourself.',
  CROSS_OWNER: 'That shift is not on your team.',
  TARGET_NOT_OWNED: 'That coworker no longer has that shift.',
  ROLE_MISMATCH: 'Trades must be between two people in the same role.',
  IN_ACTIVE_TRADE: 'One of these shifts is already in a pending trade.',
  REQUESTER_DOUBLE_BOOKED: 'You already work that day.',
  TARGET_DOUBLE_BOOKED: 'They already work that day.',
  INACTIVE_EMPLOYEE: 'That account is not active.',
};

export type TradePlan = { ok: true } | { ok: false; code: TradeRefusal };

/** The role a shift represents: its own row role, else its owner's role (same rule as offerRole). */
export function shiftRole(i: Pick<TradeableInstance, 'role'>, ownerRole: string | null): string | null {
  return i.role ?? ownerRole ?? null;
}

/** Is this row a live, owned, un-offered, future assignment — the only kind of shift a trade may touch? */
export function isTradeableRow(i: TradeableInstance, nowMs: number): TradeRefusal | null {
  if (!isClockEligibleStatus(i.status)) return 'SHIFT_NOT_ACTIVE';
  if (i.released_at || !i.employee_id) return 'SHIFT_RELEASED';
  if (i.offer_state === 'offered') return 'SHIFT_OFFERED';
  const startsMs = Date.parse(i.starts_at);
  if (!Number.isFinite(startsMs) || startsMs <= nowMs) return 'ALREADY_STARTED';
  return null;
}

/**
 * Can `me` propose swapping `mine` for `theirs` (owned by `them`)?
 *
 * `myOtherDates` / `theirOtherDates` are the dates each person ALREADY works, EXCLUDING the shift
 * they are giving up — after the swap I hold their date and they hold mine, and UNIQUE(employee_id,
 * shift_date) means neither may already have a shift there. A same-day swap (my AM for their PM)
 * is legal: the date I give up is the date I receive.
 */
export function planTradeRequest(input: {
  mine: TradeableInstance;
  theirs: TradeableInstance;
  me: TradeParty;
  them: TradeParty;
  myOtherDates: ReadonlySet<string>;
  theirOtherDates: ReadonlySet<string>;
  /** instance ids that are already part of a pending trade (either side) */
  activeTradeInstanceIds: ReadonlySet<string>;
  nowMs: number;
}): TradePlan {
  const { mine, theirs, me, them } = input;
  if (me.status !== 'active' || them.status !== 'active') return { ok: false, code: 'INACTIVE_EMPLOYEE' };
  if (mine.id === theirs.id) return { ok: false, code: 'SAME_SHIFT' };
  if (me.id === them.id) return { ok: false, code: 'SAME_EMPLOYEE' };
  if (mine.user_id !== theirs.user_id) return { ok: false, code: 'CROSS_OWNER' };
  if (mine.employee_id !== me.id) return { ok: false, code: 'NOT_YOUR_SHIFT' };
  if (theirs.employee_id !== them.id) return { ok: false, code: 'TARGET_NOT_OWNED' };
  const mineWhy = isTradeableRow(mine, input.nowMs);
  if (mineWhy) return { ok: false, code: mineWhy };
  const theirsWhy = isTradeableRow(theirs, input.nowMs);
  if (theirsWhy) return { ok: false, code: theirsWhy };
  if (!me.role || me.role !== them.role) return { ok: false, code: 'ROLE_MISMATCH' };
  if (shiftRole(mine, me.role) !== them.role || shiftRole(theirs, them.role) !== me.role) return { ok: false, code: 'ROLE_MISMATCH' };
  if (input.activeTradeInstanceIds.has(mine.id) || input.activeTradeInstanceIds.has(theirs.id)) return { ok: false, code: 'IN_ACTIVE_TRADE' };
  if (input.myOtherDates.has(theirs.shift_date)) return { ok: false, code: 'REQUESTER_DOUBLE_BOOKED' };
  if (input.theirOtherDates.has(mine.shift_date)) return { ok: false, code: 'TARGET_DOUBLE_BOOKED' };
  return { ok: true };
}

/** `dates` minus the one date `exclude` — the "other dates I work" set planTradeRequest wants. */
export function otherDates(dates: Iterable<string>, exclude: string): Set<string> {
  const s = new Set(dates);
  s.delete(exclude);
  return s;
}

export interface TradeCandidate {
  employee: TradeParty & { name: string };
  instances: TradeableInstance[];
}

export interface TradeOptionShift {
  instance_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
}

export interface TradeOptionCoworker {
  employee_id: string;
  name: string;
  role: string | null;
  shifts: TradeOptionShift[];
}

/**
 * Step 2/3 of Request Trade: which coworkers, and which of their shifts, could `mine` be swapped
 * for. Runs planTradeRequest per candidate shift so the list can never offer a swap the server
 * would refuse for a structural reason. Coworkers with no eligible shift are dropped entirely.
 */
export function buildTradeOptions(input: {
  mine: TradeableInstance;
  me: TradeParty;
  myDates: ReadonlySet<string>;
  candidates: readonly TradeCandidate[];
  activeTradeInstanceIds: ReadonlySet<string>;
  nowMs: number;
}): TradeOptionCoworker[] {
  const myOther = otherDates(input.myDates, input.mine.shift_date);
  const out: TradeOptionCoworker[] = [];
  for (const c of input.candidates) {
    if (c.employee.id === input.me.id) continue;
    const theirDatesAll = new Set(c.instances.filter((i) => isClockEligibleStatus(i.status) && i.employee_id === c.employee.id).map((i) => i.shift_date));
    const shifts: TradeOptionShift[] = [];
    for (const theirs of c.instances) {
      const plan = planTradeRequest({
        mine: input.mine,
        theirs,
        me: input.me,
        them: c.employee,
        myOtherDates: myOther,
        theirOtherDates: otherDates(theirDatesAll, theirs.shift_date),
        activeTradeInstanceIds: input.activeTradeInstanceIds,
        nowMs: input.nowMs,
      });
      if (plan.ok) shifts.push({ instance_id: theirs.id, shift_date: theirs.shift_date, starts_at: theirs.starts_at, ends_at: theirs.ends_at });
    }
    if (shifts.length > 0) {
      shifts.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
      out.push({ employee_id: c.employee.id, name: c.employee.name, role: c.employee.role, shifts });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Coworker response / requester cancel ─────────────────────────────────────────────────────

export type TradeStatusValue = 'pending_coworker' | 'pending_manager' | 'approved' | 'declined' | 'cancelled';

export type RespondRefusal = 'NOT_TARGET' | 'NOT_PENDING_COWORKER';
export const RESPOND_REFUSAL_MESSAGES: Record<RespondRefusal, string> = {
  NOT_TARGET: 'This trade was not sent to you.',
  NOT_PENDING_COWORKER: 'This trade is no longer waiting for your answer.',
};

/** May `employeeId` accept/decline this trade right now? */
export function planCoworkerResponse(trade: { target_employee_id: string; status: string }, employeeId: string): { ok: true } | { ok: false; code: RespondRefusal } {
  if (trade.target_employee_id !== employeeId) return { ok: false, code: 'NOT_TARGET' };
  if (trade.status !== 'pending_coworker') return { ok: false, code: 'NOT_PENDING_COWORKER' };
  return { ok: true };
}

export type CancelRefusal = 'NOT_REQUESTER' | 'NOT_CANCELLABLE';
export const CANCEL_REFUSAL_MESSAGES: Record<CancelRefusal, string> = {
  NOT_REQUESTER: 'Only the person who proposed this trade can cancel it.',
  NOT_CANCELLABLE: 'This trade has already been decided.',
};

/** The requester may withdraw while nobody has approved it — before OR after the coworker accepts. */
export function planCancel(trade: { requester_employee_id: string; status: string }, employeeId: string): { ok: true } | { ok: false; code: CancelRefusal } {
  if (trade.requester_employee_id !== employeeId) return { ok: false, code: 'NOT_REQUESTER' };
  if (trade.status !== 'pending_coworker' && trade.status !== 'pending_manager') return { ok: false, code: 'NOT_CANCELLABLE' };
  return { ok: true };
}

/** Manager-facing sentences for the approval RPC's refusal reasons. */
export const TRADE_APPROVE_MESSAGES: Record<string, string> = {
  TRADE_NOT_FOUND: 'That trade no longer exists.',
  TRADE_NOT_PENDING: 'That trade is no longer waiting for approval.',
  ALREADY_APPROVED: 'That trade was already approved.',
  SHIFT_NOT_FOUND: 'One of the shifts no longer exists.',
  REQUESTER_NO_LONGER_OWNS: 'The requester no longer has the shift they offered.',
  TARGET_NO_LONGER_OWNS: 'The coworker no longer has the shift they agreed to give.',
  SHIFT_NOT_ACTIVE: 'One of the shifts is no longer on the schedule.',
  SHIFT_RELEASED: 'One of the shifts is on the open-shift board.',
  SHIFT_OFFERED: 'One of the shifts is currently offered for pickup — resolve that first.',
  ALREADY_STARTED: 'One of the shifts has already started.',
  EMPLOYEE_UNAVAILABLE: 'One of the employees is no longer active.',
  ROLE_MISMATCH: 'These two employees are not in the same role.',
  CONFLICTING_TRADE: 'Another pending trade involves one of these shifts — decide that one first.',
  EMPLOYEE_DOUBLE_BOOKED: 'One of them is already scheduled on the other day.',
  TRADE_CHANGED: 'This trade changed while you were deciding — reload the queue.',
};
