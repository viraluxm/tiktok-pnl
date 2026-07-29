// Pure time-clock logic — no React, no Supabase, no Date-of-record. This is the single
// source of truth for the attendance STATE MACHINE and the derived-value math, shared by
// the kiosk UI (to enable/disable actions and pre-empt obvious errors) and by the unit
// tests. It MIRRORS the server RPCs in supabase/migrations/071_time_clock_rpcs.sql — the
// server remains authoritative (it holds the locks and stamps the time); this module must
// be kept in sync so the UI never offers an action the DB will reject.

import type { TimeEntryStatus } from '@/types';

// The three states an employee can be in, from the kiosk's point of view.
export type AttendanceState = 'clocked_out' | 'working' | 'on_break';

// The four kiosk actions.
export type TimeClockAction = 'clock_in' | 'start_break' | 'end_break' | 'clock_out';

// Stable error tokens raised by the RPCs (and pre-empted here). The UI turns these into a
// friendly, name-personalised sentence via friendlyClockError().
export type ClockErrorToken =
  | 'ALREADY_CLOCKED_IN'
  | 'NOT_CLOCKED_IN'
  | 'ALREADY_ON_BREAK'
  | 'NO_ACTIVE_BREAK'
  | 'BREAK_OPEN'
  | 'EMPLOYEE_NOT_FOUND'
  | 'NOT_AUTHENTICATED'
  // Manager confirm/unconfirm tokens (lensed_confirm/unconfirm_time_clock_shift, 069):
  | 'SHIFT_NOT_FOUND'
  | 'SHIFT_NOT_TIME_CLOCK'
  | 'SHIFT_NOT_CLOSED'
  | 'TIME_ENTRY_NOT_FOUND'
  | 'TIME_ENTRY_NOT_CLOSED';

// Which actions are allowed from each state. This table IS the state machine:
//   clocked_out → only Clock In
//   working     → Start Break or Clock Out
//   on_break    → only End Break (must end the break before clocking out)
export const ALLOWED_ACTIONS: Readonly<Record<AttendanceState, readonly TimeClockAction[]>> = {
  clocked_out: ['clock_in'],
  working: ['start_break', 'clock_out'],
  on_break: ['end_break'],
};

export function isActionAllowed(state: AttendanceState, action: TimeClockAction): boolean {
  return ALLOWED_ACTIONS[state].includes(action);
}

// The token the server WOULD raise for a blocked action — computed locally so the UI and
// tests agree with the DB without a round-trip. Returns null when the action is allowed.
export function blockedReason(state: AttendanceState, action: TimeClockAction): ClockErrorToken | null {
  if (isActionAllowed(state, action)) return null;
  switch (action) {
    case 'clock_in':
      return 'ALREADY_CLOCKED_IN'; // blocked only when already working/on_break
    case 'start_break':
      return state === 'on_break' ? 'ALREADY_ON_BREAK' : 'NOT_CLOCKED_IN';
    case 'end_break':
      return 'NO_ACTIVE_BREAK'; // blocked only when not on a break
    case 'clock_out':
      return state === 'on_break' ? 'BREAK_OPEN' : 'NOT_CLOCKED_IN';
  }
}

// The resulting state after a SUCCESSFUL action — a pure mirror of each RPC's effect.
// Throws (with the server's token as message) if the action isn't allowed from `state`.
export function nextState(state: AttendanceState, action: TimeClockAction): AttendanceState {
  const blocked = blockedReason(state, action);
  if (blocked) throw new Error(blocked);
  switch (action) {
    case 'clock_in':
      return 'working';
    case 'start_break':
      return 'on_break';
    case 'end_break':
      return 'working';
    case 'clock_out':
      return 'clocked_out';
  }
}

// Derive an employee's current attendance state from their open time entry (or lack of one).
// `null`/`undefined` (no open entry) → clocked_out.
export function attendanceStateOf(
  entry: { status: TimeEntryStatus } | null | undefined,
): AttendanceState {
  if (!entry) return 'clocked_out';
  switch (entry.status) {
    case 'on_break':
      return 'on_break';
    case 'open':
      return 'working';
    case 'closed':
      return 'clocked_out';
  }
}

// Total unpaid break minutes from a set of break rows. ROUNDING RULE: every punch is
// truncated to its whole minute (seconds dropped) BEFORE differencing — the SAME rule the
// clock-out RPC applies to clock-in/clock-out — so seconds are discarded identically across
// all punches and can never cause a differential over/underpay. Mirrors the SQL
// `date_trunc('minute', ...)` in public.lensed_clock_out. An open break counts up to `nowMs`.
export function computeBreakMinutes(
  breaks: ReadonlyArray<{ started_at: string; ended_at: string | null }>,
  nowMs: number = Date.now(),
): number {
  const floorToMinute = (ms: number) => Math.floor(ms / 60000) * 60000;
  let minutes = 0;
  for (const b of breaks) {
    const start = Date.parse(b.started_at);
    if (!Number.isFinite(start)) continue;
    const end = b.ended_at == null ? nowMs : Date.parse(b.ended_at);
    if (!Number.isFinite(end)) continue;
    const diffMs = floorToMinute(end) - floorToMinute(start);
    if (diffMs > 0) minutes += diffMs / 60000;
  }
  return Math.round(minutes);
}

// ── Deriving the shift row from raw punches (a JS MIRROR of the SQL in migration 071) ──
// The clock-out RPC is authoritative; this reproduces its math so a client can preview a
// shift and the unit tests can assert the mapping. Wall-clock values are computed in
// `timeZone` exactly like `(ts at time zone tz)` in Postgres. Keep in sync with
// public.lensed_clock_out.
export interface DerivedTimeClockShift {
  date: string; // 'YYYY-MM-DD' in timeZone
  start_time: string; // 'HH:MM:SS' in timeZone
  end_time: string; // 'HH:MM:SS' in timeZone
  break_minutes: number;
}

function zonedParts(iso: string, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

export function zonedDate(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function zonedTime(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function deriveTimeClockShift(
  clockedInAt: string,
  clockedOutAt: string,
  breaks: ReadonlyArray<{ started_at: string; ended_at: string | null }>,
  timeZone: string,
): DerivedTimeClockShift {
  // Truncate start/end to the whole minute (HH:MM:00) — the SAME rule as break minutes and
  // the clock-out RPC — so seconds are dropped consistently on every punch.
  const truncMinute = (t: string) => `${t.slice(0, 5)}:00`;
  return {
    date: zonedDate(clockedInAt, timeZone),
    start_time: truncMinute(zonedTime(clockedInAt, timeZone)),
    end_time: truncMinute(zonedTime(clockedOutAt, timeZone)),
    break_minutes: computeBreakMinutes(breaks),
  };
}

// Turn a server/state token into a friendly, employee-named sentence for the kiosk.
// `action` lets us give the retry-after-success case ("already recorded") a calmer message
// than a hard error, per the product spec.
export function friendlyClockError(
  token: string,
  name: string,
  action?: TimeClockAction,
): string {
  if (action === 'clock_out' && token === 'NOT_CLOCKED_IN') {
    return 'This action was already recorded.';
  }
  switch (token) {
    case 'ALREADY_CLOCKED_IN':
      return `${name} is already clocked in.`;
    case 'NOT_CLOCKED_IN':
      return `${name} is not clocked in.`;
    case 'ALREADY_ON_BREAK':
      return `${name} is already on a break.`;
    case 'NO_ACTIVE_BREAK':
      return `${name} does not have an active break.`;
    case 'BREAK_OPEN':
      return `Please end ${name}'s break before clocking out.`;
    case 'EMPLOYEE_NOT_FOUND':
      return `${name} is not an active employee.`;
    case 'NOT_AUTHENTICATED':
      return 'This kiosk was signed out. A manager needs to sign in again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// Manager-facing message for a confirm/unconfirm token (raised by the server RPCs). Kept
// separate from friendlyClockError because these are surfaced in the Shifts admin UI, not
// the kiosk, and are not employee-name oriented.
export function confirmErrorMessage(token: string): string {
  switch (token) {
    case 'SHIFT_NOT_FOUND':
      return 'That shift no longer exists, or it is not yours.';
    case 'SHIFT_NOT_TIME_CLOCK':
      return 'Only time-clock shifts use confirmation.';
    case 'SHIFT_NOT_CLOSED':
      return 'This shift has no end time yet.';
    case 'TIME_ENTRY_NOT_FOUND':
      return "This shift's time entry is missing.";
    case 'TIME_ENTRY_NOT_CLOSED':
      return 'The employee is still clocked in for this shift.';
    case 'BREAK_OPEN':
      return 'End the open break before confirming.';
    case 'NOT_AUTHENTICATED':
      return 'Your session expired — please sign in again.';
    default:
      return 'Could not update confirmation. Please try again.';
  }
}

// UI metadata for the four kiosk buttons, in display order. `verb` seeds the confirmation
// prompt, e.g. "Clock in as Maria Lopez?".
export interface TimeClockActionMeta {
  action: TimeClockAction;
  label: string; // button label
  verb: string; // confirmation-sentence verb, lowercased
}

export const TIME_CLOCK_ACTIONS: readonly TimeClockActionMeta[] = [
  { action: 'clock_in', label: 'Clock In', verb: 'Clock in' },
  { action: 'start_break', label: 'Start Break', verb: 'Start break for' },
  { action: 'end_break', label: 'End Break', verb: 'End break for' },
  { action: 'clock_out', label: 'Clock Out', verb: 'Clock out' },
];

// Extract the stable token from a thrown/rpc error whose message is one of our tokens
// (Supabase surfaces a raised plpgsql exception as error.message). Falls back to the raw
// message so unexpected errors still surface something.
export function clockErrorToken(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg || 'UNKNOWN';
}

// ── Team grouping for the kiosk employee picker ─────────────────────────────
// employees.role is FREE TEXT. The app matches it case-insensitively everywhere (PayView
// role filter, host badges), so we normalise the same way. Known equivalents map to a team;
// anything else falls into 'other' so an active employee is NEVER hidden by an unexpected
// role. This is display-only — it does not read or change stored role values.
export type TeamKey = 'host' | 'fulfillment' | 'other';

export interface TeamMeta {
  key: TeamKey;
  label: string;
}

// Live Host + Fulfillment are always offered; 'Other' is shown only when it has members
// (the caller checks). Order is display order.
export const TEAMS: readonly TeamMeta[] = [
  { key: 'host', label: 'Live Host' },
  { key: 'fulfillment', label: 'Fulfillment' },
  { key: 'other', label: 'Other' },
];

export function teamOfRole(role: string | null | undefined): TeamKey {
  const r = (role ?? '').trim().toLowerCase();
  if (r === 'host' || r === 'live host') return 'host';
  if (r === 'fulfillment') return 'fulfillment';
  return 'other';
}

export function teamLabel(key: TeamKey): string {
  return TEAMS.find((t) => t.key === key)?.label ?? 'Other';
}

// Short, employee-facing reason the action is unavailable from `state` (null = allowed).
// Used to render a disabled employee card so nobody silently disappears. The RPC remains
// the final authority — this only mirrors its state machine for the UI.
export function unavailableReason(state: AttendanceState, action: TimeClockAction): string | null {
  const token = blockedReason(state, action);
  if (!token) return null;
  switch (token) {
    case 'ALREADY_CLOCKED_IN':
      return 'Already clocked in';
    case 'NOT_CLOCKED_IN':
      return 'Not currently clocked in';
    case 'ALREADY_ON_BREAK':
      return 'Currently on break';
    case 'BREAK_OPEN':
      return 'Currently on break';
    case 'NO_ACTIVE_BREAK':
      return 'No active break';
    default:
      return 'Unavailable';
  }
}
