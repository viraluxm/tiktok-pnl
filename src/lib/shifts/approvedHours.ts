// APPROVED HOURS — the pure kernel behind the manager's hrs/min input at confirmation.
//
// Approved hours are the FINAL PAYABLE duration for a shift (migration 137), stored as whole
// minutes on `shifts.approved_minutes`. They are deliberately NOT the clock-in→clock-out span:
// for a live host, payable time is the verified live-session duration, and the punch stays as the
// attendance record rather than being rewritten to move payroll.
//
// APPROVED HOURS ARE A LIVE-HOST INSTRUMENT AND NOTHING ELSE. approvedHoursApply() below is the
// one predicate that says so, and every other rule in this module is derived from it. Fulfillment
// worked time is fully determined by the punch — clock in, clock out, breaks — so an approval box
// beside it is not a second opinion, it is a way to type a number over an already-correct one.
// Production carried 37 such rows within three days of the feature shipping; 33 were the prefilled
// clocked figure retyped back at itself and one was a fat-finger 23h41m on a 7h40m shift. So for
// anyone who is not a live host there is no input, no override, and nothing written.
//
// No imports: this transpiles standalone for approvedHours.test.mjs, and the numbers it produces
// go straight into an RPC argument, so every rule about what a manager may type lives here rather
// than in JSX.

/** Matches the CHECK on shifts.approved_minutes (0 … 1440). 24h is the ceiling for one shift. */
export const MAX_APPROVED_MINUTES = 1440;

export type ApprovedInputRefusal =
  | 'MISSING'          // nothing typed at all, and this shift requires a value
  | 'NOT_A_NUMBER'
  | 'MINUTES_RANGE'    // the minutes box must read 0–59
  | 'NEGATIVE'
  | 'TOO_LONG';        // more than MAX_APPROVED_MINUTES in total

export const APPROVED_INPUT_MESSAGES: Record<ApprovedInputRefusal, string> = {
  MISSING: 'Enter the approved hours for this shift.',
  NOT_A_NUMBER: 'Enter approved hours as whole numbers.',
  MINUTES_RANGE: 'Minutes must be between 0 and 59.',
  NEGATIVE: 'Approved hours cannot be negative.',
  TOO_LONG: 'Approved hours cannot exceed 24 hours for one shift.',
};

export type ApprovedInput =
  | { ok: true; minutes: number | null }        // null = deliberately left blank, and allowed to be
  | { ok: false; code: ApprovedInputRefusal };

/**
 * Read the two boxes the manager types into.
 *
 * `required` is true for a live host: their payable time cannot be inferred from the punch, so a
 * blank box is a refusal rather than "use the default". For everyone else a blank pair means "no
 * explicit approval" and payroll keeps its legacy calculation — the same fallback that leaves
 * historical shifts untouched.
 *
 * Both boxes are read as whole numbers. '' and undefined are blank; anything non-numeric is a
 * refusal rather than a silent 0, because a silently-zeroed hours box would approve a shift for
 * 58 minutes.
 */
export function parseApprovedInput(
  hoursText: string | undefined,
  minutesText: string | undefined,
  required: boolean,
): ApprovedInput {
  const h = (hoursText ?? '').trim();
  const m = (minutesText ?? '').trim();
  if (h === '' && m === '') return required ? { ok: false, code: 'MISSING' } : { ok: true, minutes: null };

  const hours = h === '' ? 0 : Number(h);
  const mins = m === '' ? 0 : Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return { ok: false, code: 'NOT_A_NUMBER' };
  if (hours < 0 || mins < 0) return { ok: false, code: 'NEGATIVE' };
  // 0–59 in the minutes box: "7 hrs 90 min" is ambiguous enough that accepting it as 8h30m would
  // eventually approve an hour nobody typed.
  if (mins > 59) return { ok: false, code: 'MINUTES_RANGE' };

  const total = hours * 60 + mins;
  if (total > MAX_APPROVED_MINUTES) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, minutes: total };
}

/** Split stored minutes back into the two boxes. 478 → { hours: '7', minutes: '58' }. */
export function splitApprovedMinutes(minutes: number | null | undefined): { hours: string; minutes: string } {
  if (minutes == null) return { hours: '', minutes: '' };
  const safe = Math.max(0, Math.round(minutes));
  return { hours: String(Math.floor(safe / 60)), minutes: String(safe % 60) };
}

/** '7h 58m' — the same shape fmtDuration uses in the portal, so both surfaces read alike. */
export function formatApprovedMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}h ${String(safe % 60).padStart(2, '0')}m`;
}

/**
 * The union teamOfRole() in '@/lib/timeclock' returns. Restated here rather than imported so this
 * module stays dependency-free and transpiles standalone for its test; the two are asserted equal
 * in src/lib/shifts/approvedHoursLiveHostOnly.test.mjs.
 */
export type ApprovedTeam = 'host' | 'fulfillment' | 'other';

/**
 * DOES THE APPROVED-HOURS CONCEPT EXIST FOR THIS TEAM AT ALL? This is the whole rule, in one
 * place: only a live host has a payable duration that is not simply their punch.
 *
 * Everyone else — fulfillment today, any future role tomorrow — is paid the canonical worked-time
 * calculation (clock in → clock out − breaks, i.e. clockedShiftHours), which paidShiftHours()
 * already returns whenever approved_minutes is NULL. So there is nothing to offer, nothing to
 * validate and nothing to write.
 *
 * Stated as `=== 'host'` rather than `!== 'fulfillment'` on purpose: a role that is neither must
 * fall on the SAFE side (no override), not inherit the host exception by accident.
 */
export function approvedHoursApply(team: ApprovedTeam): boolean {
  return team === 'host';
}

/**
 * Does this shift REQUIRE an explicit approved duration before it can be confirmed?
 *
 * Live hosts: yes. Their payable time is verified live time; defaulting to the clocked span is the
 * overpayment this whole change exists to prevent, and there is no authoritative shift→live-session
 * link in the schema to read the real figure from. So the manager states it.
 *
 * Derived from approvedHoursApply() rather than restating `=== 'host'`, so "who gets the input"
 * and "who must fill it in" can never drift apart. The SQL side of the same rule
 * (lensed_confirm_time_clock_shift) is asserted against teamOfRole in the tests.
 */
export function approvedMinutesRequired(team: ApprovedTeam): boolean {
  return approvedHoursApply(team);
}

/**
 * THE WRITE GATE. Every approved-minutes value that leaves this app for the database passes
 * through here, and for a non-host it becomes NULL — which is exactly the state paidShiftHours()
 * reads as "pay the canonical worked time".
 *
 * This exists because hiding an input is not a rule. The two RPCs that can set the column
 * (lensed_confirm_time_clock_shift, lensed_set_approved_minutes) are issued from ONE module,
 * useShifts.ts, and both call this on the way out — so a future surface that renders its own
 * confirm button, or a caller that forgets the role check, still cannot create a fulfillment
 * override. The team is a REQUIRED argument on those mutations for the same reason: minutes
 * cannot travel to the RPC without the team that authorises them.
 *
 * NOT retroactive, deliberately. It shapes new writes only; the 37 historical rows that already
 * carry a value are untouched by this function and keep paying exactly what they pay today.
 */
export function approvedMinutesForTeam(team: ApprovedTeam, minutes: number | null): number | null {
  return approvedHoursApply(team) ? minutes : null;
}
