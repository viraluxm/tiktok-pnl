// APPROVED HOURS — the pure kernel behind the manager's hrs/min input at confirmation.
//
// Approved hours are the FINAL PAYABLE duration for a shift (migration 137), stored as whole
// minutes on `shifts.approved_minutes`. They are deliberately NOT the clock-in→clock-out span:
// for a live host, payable time is the verified live-session duration, and the punch stays as the
// attendance record rather than being rewritten to move payroll.
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
 * Does this shift REQUIRE an explicit approved duration before it can be confirmed?
 *
 * Live hosts: yes. Their payable time is verified live time; defaulting to the clocked span is the
 * overpayment this whole change exists to prevent, and there is no authoritative shift→live-session
 * link in the schema to read the real figure from. So the manager states it.
 *
 * `team` comes from teamOfRole() in '@/lib/timeclock' — the app's one role normalisation. It is
 * passed in rather than imported so this module stays dependency-free; the SQL side of the same
 * rule (lensed_confirm_time_clock_shift) is asserted against teamOfRole in the tests.
 */
export function approvedMinutesRequired(team: 'host' | 'fulfillment' | 'other'): boolean {
  return team === 'host';
}
