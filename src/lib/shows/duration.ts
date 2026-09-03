/**
 * Active-selling duration for one live show.
 *
 * EXTRACTED, NOT REWRITTEN. This logic was inline in /api/live/sessions/[id]/duration, which is
 * the denominator of the Units/hr card. The net-economics route now needs the SAME figure — it
 * is the denominator of net profit/hour and the multiplier for host pay — and two copies would
 * eventually disagree, putting two cards on one screen that cannot both be right. So the rule
 * moved here unchanged and both routes call it.
 *
 * Pure: takes the three instants, returns the duration. No I/O, no clock read.
 */

// A stale ended_at this far past the last capture is not believed. A show can read "Live" for
// days, and it can also be ended long after the last sale; either way the last capture is the
// end of ACTIVE SELLING, which is what these cards divide by.
const MAX_ENDED_AT_LAG_MS = 6 * 3600 * 1000;

export type DurationSource = 'ended_at' | 'last_capture';

export interface ShowDurationInput {
  started_at: string | null;
  ended_at: string | null;
  last_capture_at: string | null;
}

export interface ShowDuration {
  duration_ms: number | null;
  source: DurationSource;
  end: string | null;
}

/**
 * Prefer ended_at only when it is SANE: after the start, and not wildly past the last sale
 * (that guards an "ended days later" value). Otherwise fall back to the last capture in the
 * session window.
 */
export function resolveShowDuration(input: ShowDurationInput): ShowDuration {
  const { started_at, ended_at, last_capture_at } = input;

  let source: DurationSource = 'last_capture';
  let end: string | null = last_capture_at;
  if (ended_at && started_at) {
    const s = new Date(started_at).getTime();
    const e = new Date(ended_at).getTime();
    const lc = last_capture_at ? new Date(last_capture_at).getTime() : null;
    const sane = e > s && (lc == null || e <= lc + MAX_ENDED_AT_LAG_MS);
    if (sane) { source = 'ended_at'; end = ended_at; }
  }

  const duration_ms = end && started_at
    ? new Date(end).getTime() - new Date(started_at).getTime()
    : null;

  return { duration_ms, source, end };
}
