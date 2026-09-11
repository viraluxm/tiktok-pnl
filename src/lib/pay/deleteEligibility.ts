import type { StatementRow } from './statement';

// WHICH WORKED-TIME RECORDS CAN BE DELETED FROM PAY DETAILS — one rule, so the Pay tab and the
// review preview cannot disagree about it.
//
// This is not a payroll rule and it changes no money. It answers a narrower question: can removing
// this `shifts` row be relied on to actually remove the record, and stay removed?
//
// MANUAL — YES. A manual row is a hand-entered correction with no punch behind it. Verified against
// production: 224 manual rows, ZERO of them referenced by an employee_time_entries row. Deleting
// the shift deletes the whole record, and nothing in the system recreates it — the reconciler's
// back-fill (migration 072) only ever inserts source='time_clock' rows. useShifts.deleteShift is
// the existing canonical writer, RLS-scoped to auth.uid() = user_id, already used by the calendar's
// editor; no second deletion system is introduced.
//
// TIME CLOCK — NO, and this is a block rather than an oversight:
//   * every time_clock row is linked to a raw punch (461/461 in production), and
//     employee_time_entries.shift_id is ON DELETE SET NULL (070:110; confirmed live as
//     confdeltype='n'), so deleting the shift ORPHANS the punch instead of removing it;
//   * migration 072's reconciler then RECREATES the shift — its back-fill loop selects
//     `clocked_out_at is not null and shift_id is null` and inserts a fresh time_clock row with
//     confirmed_at NULL. The delete would quietly undo itself AND drop the manager's confirmation.
//     Production already holds 16 orphaned entries, so that input path is real, not hypothetical.
//     (The write is currently behind TIME_CLOCK_RECONCILE_WRITE_ENABLED, but an env flag being off
//     today is not a safety guarantee.)
//   * deleting the punch too is not a payroll screen's call: the raw entries are the auditable
//     trail, and migration 131 is explicit that they are never rewritten to make a correction fit.
//
// Taking a punch out of pay already has a safe, reversible action — unconfirming it — so nothing
// is lost by refusing here. That is what the disabled control says.

export const TIME_CLOCK_DELETE_BLOCKED_REASON =
  'Time-clock records cannot be deleted — they come from a punch. Unconfirm it to take it out of pay.';

/** True only for records whose deletion is complete and cannot be undone by the reconciler. */
export function canDeleteRecord(row: Pick<StatementRow, 'source'>): boolean {
  return row.source === 'manual';
}

/** Why Delete is unavailable, or undefined when it is available. */
export function deleteBlockedReasonFor(row: Pick<StatementRow, 'source'>): string | undefined {
  return canDeleteRecord(row) ? undefined : TIME_CLOCK_DELETE_BLOCKED_REASON;
}
