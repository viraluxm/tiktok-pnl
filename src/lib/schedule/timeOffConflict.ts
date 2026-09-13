/**
 * Time-off ↔ schedule conflict rules — pure, dependency-free (transpile-testable, see
 * timeOffConflict.test.mjs).
 *
 * These answer one question for the schedule builder: "is this person off on this date, and how
 * firmly?" Nothing here writes, and nothing here BLOCKS. A time-off request is information the
 * manager needs while building the schedule, not a lock on it — there is always the occasional
 * legitimate override, so every surface that uses this warns and then lets the manager proceed.
 *
 * THIS FILE DOES NOT DECIDE ANYTHING ABOUT SHIFTS. Approving time off has never deleted, moved or
 * cancelled a shift (see api/admin/time-off PATCH, and the note in migration 120), and adding
 * these markers does not change that. A day that is both "approved time off" and "shift
 * scheduled" is reported as exactly that and left alone for a human to resolve.
 *
 * Dates are plain inclusive 'YYYY-MM-DD' calendar strings on both sides — `time_off_requests`
 * stores `date` columns and `shift_instances.shift_date` is a `date` too — so every comparison
 * here is a string compare and no timezone can shift a day. Range expansion steps through UTC
 * midnights for the same reason (DST cannot move a UTC day boundary).
 *
 * Kept free of VALUE imports so the test can transpile it alone; the one thing it would want from
 * elsewhere, a 'Sep 26' date formatter, is injected instead (same trick timeOff.ts uses for
 * `periodStartOf`).
 */

/** How firmly someone is off. 'denied' and 'withdrawn' are absent on purpose — see `isTimeOffMark`. */
export type TimeOffMark = 'pending' | 'approved';

/** The minimum shape these rules need. The API row (TimeOffRow) is a superset of it. */
export interface TimeOffSpan {
  employee_id: string;
  /** Inclusive first day, 'YYYY-MM-DD'. */
  start_date: string;
  /** Inclusive last day, 'YYYY-MM-DD'. A single-day request sets end_date = start_date. */
  end_date: string;
  status: string;
}

/**
 * A request cannot legally span this far (TIME_OFF_MAX_DAYS is 14), so a longer range means a bad
 * row. Expansion stops rather than looping — a corrupt date must not hang the schedule builder.
 */
const MAX_SPAN_DAYS = 60;

/**
 * Only PENDING and APPROVED mark a day.
 *
 * A DENIED request means the manager already said no and the person is expected to work: showing
 * it in the builder would say the opposite of what was decided, and would clutter the grid with
 * settled history. It stays visible in the Time-off Requests modal, which is where history
 * belongs. 'withdrawn' never leaves the API in the first place.
 */
export function isTimeOffMark(status: string): status is TimeOffMark {
  return status === 'pending' || status === 'approved';
}

/** Inclusive [start_date, end_date] expanded to the individual days it covers. */
export function timeOffDays(r: Pick<TimeOffSpan, 'start_date' | 'end_date'>): string[] {
  const out: string[] = [];
  const [y, m, d] = r.start_date.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  while (cur.toISOString().slice(0, 10) <= r.end_date) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (out.length >= MAX_SPAN_DAYS) break;
  }
  return out;
}

/**
 * date -> the requests touching it, across everyone. Drives the month grid's per-day badge, which
 * asks "is anyone off this day?" rather than "is THIS person off?".
 */
export function indexTimeOffByDate<T extends TimeOffSpan>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    if (!isTimeOffMark(r.status)) continue;
    for (const d of timeOffDays(r)) {
      const arr = m.get(d);
      if (arr) arr.push(r); else m.set(d, [r]);
    }
  }
  return m;
}

/** `${employee_id}|${date}` -> the strongest mark on that person-day. Built once per query result. */
export type TimeOffDayIndex = Map<string, TimeOffMark>;

const keyOf = (employeeId: string, date: string) => `${employeeId}|${date}`;

/**
 * One person, one day, one answer.
 *
 * APPROVED WINS over pending when someone has two overlapping requests covering the same date
 * (they asked twice, or a long request overlaps a short one). Reporting the weaker of the two
 * would understate the constraint on exactly the day where it matters most.
 */
export function indexTimeOffByEmployeeDate(rows: TimeOffSpan[]): TimeOffDayIndex {
  const m: TimeOffDayIndex = new Map();
  for (const r of rows) {
    if (!isTimeOffMark(r.status)) continue;
    for (const d of timeOffDays(r)) {
      const k = keyOf(r.employee_id, d);
      if (r.status === 'approved' || !m.has(k)) m.set(k, r.status);
    }
  }
  return m;
}

/** The mark on one person-day, or null when they are available. */
export function timeOffMarkFor(
  index: TimeOffDayIndex, employeeId: string, date: string,
): TimeOffMark | null {
  return index.get(keyOf(employeeId, date)) ?? null;
}

/** employee_id -> mark, for ONE date. For the day-at-a-time surfaces (the crew picker). */
export function timeOffOnDate(rows: TimeOffSpan[], date: string): Map<string, TimeOffMark> {
  const m = new Map<string, TimeOffMark>();
  for (const r of rows) {
    if (!isTimeOffMark(r.status)) continue;
    if (date < r.start_date || date > r.end_date) continue;
    if (r.status === 'approved' || !m.has(r.employee_id)) m.set(r.employee_id, r.status);
  }
  return m;
}

/** The wording, in one place, so no two surfaces can describe the same state differently. */
export const TIME_OFF_LABEL: Record<TimeOffMark, string> = {
  pending: 'Time off requested',
  approved: 'Approved time off',
};

/**
 * What a schedule cell says. A day that is BOTH off and scheduled is the case a manager most needs
 * to see, and it is stated as both facts rather than resolved into one — resolving it is their
 * call, not ours.
 */
export function timeOffCellLabel(mark: TimeOffMark, hasShift: boolean): string {
  return hasShift ? `${TIME_OFF_LABEL[mark]} · Shift scheduled` : TIME_OFF_LABEL[mark];
}

export interface TimeOffConflict {
  date: string;
  mark: TimeOffMark;
}

/** Every requested-off day among `dates`, in the order given. `dates` is normally a week. */
export function timeOffConflictsFor(
  index: TimeOffDayIndex, employeeId: string, dates: readonly string[],
): TimeOffConflict[] {
  const out: TimeOffConflict[] = [];
  for (const date of dates) {
    const mark = timeOffMarkFor(index, employeeId, date);
    if (mark) out.push({ date, mark });
  }
  return out;
}

/** "Sep 26, Sep 27" — capped so a long repeat cannot produce an unreadable dialog. */
const MAX_LISTED = 6;
function listDates(dates: string[], fmtDate: (iso: string) => string): string {
  const shown = dates.slice(0, MAX_LISTED).map(fmtDate).join(', ');
  const rest = dates.length - MAX_LISTED;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * The confirmation a manager reads before scheduling over time off. A WARNING, never a block:
 * the caller's Cancel / OK maps to Cancel / Schedule anyway.
 *
 * Approved and pending are stated on separate lines rather than merged, because they carry
 * different weight and a mixed save should not flatten the approved days into the softer wording.
 * `fmtDate` is injected to keep this file import-free; callers pass fmtMonthDay.
 */
export function timeOffConfirmMessage(
  name: string,
  conflicts: TimeOffConflict[],
  fmtDate: (iso: string) => string = (d) => d,
): string {
  const approved = conflicts.filter((c) => c.mark === 'approved').map((c) => c.date);
  const pending = conflicts.filter((c) => c.mark === 'pending').map((c) => c.date);
  const lines: string[] = [];
  if (approved.length > 0) {
    lines.push(`${name} has approved time off on ${listDates(approved, fmtDate)}.`);
  }
  if (pending.length > 0) {
    lines.push(`${name} requested ${listDates(pending, fmtDate)} off.`);
  }
  lines.push('', conflicts.length === 1 ? 'Schedule this shift anyway?' : 'Schedule these shifts anyway?');
  return lines.join('\n');
}
