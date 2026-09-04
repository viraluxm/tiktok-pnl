// What subset of a shop's backlog a label run covers.
//
// WHY SCOPE EXISTS AT ALL. "Buy everything outstanding" is the wrong default for an operation
// that runs 9-10 overlapping lives a day: the backlog spans several shows in different states,
// and the person buying labels is thinking in terms of "last night's shows" or "that one room",
// not "all 400 boxes Lensed currently knows about".
//
// TWO SHAPES, because those are the two ways the work is actually talked about:
//
//   DAY — a fulfilment day, 04:00 to 04:00 local. Not midnight: shows run 17:00 to past 01:00,
//   so a midnight boundary would cut one night's work in half and put the tail on the wrong
//   day. This is the same boundary the picker KPIs use (SHIFT_DAY_START_HOUR).
//
//   LIVES — one or more sessions, chosen explicitly. Necessary because shows overlap and span
//   the day boundary, so "the day" and "that show" are genuinely different sets.
//
// Scope NARROWS the candidate set. It never widens it and never overrides a safety gate: the
// age floor and the running-show exclusion apply to whatever scope selects, so choosing a live
// that is still running yields nothing rather than buying mid-show.

import { zonedDayRangeUtcMs, zonedDayKey, SHOP_TIMEZONE } from '@/lib/shipping/pickerPerformance';

export type LabelScope =
  | { kind: 'all' }
  | { kind: 'day'; day: string }
  | { kind: 'lives'; sessionIds: string[] };

/** Most lives selectable in one run. A guard against an unbounded id list in the query. */
export const MAX_SCOPE_LIVES = 40;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse `?day=` / `?session_ids=` into a scope, or return why it is invalid.
 *
 * Rejects rather than falling back to 'all' on a malformed value. A typo'd day silently
 * becoming "the entire backlog" is the one failure mode worth being strict about here, because
 * the next thing the operator does is authorise it.
 */
export function parseScope(
  params: { day?: string | null; sessionIds?: string | null },
): { scope: LabelScope } | { error: string } {
  const day = params.day?.trim() || null;
  const ids = params.sessionIds?.trim() || null;

  if (day && ids) return { error: 'Pass either day or session_ids, not both' };

  if (day) {
    if (!DAY_RE.test(day)) return { error: 'day must be YYYY-MM-DD' };
    // Date.parse on a bare YYYY-MM-DD is UTC midnight, which is fine for validity checking.
    if (Number.isNaN(Date.parse(day))) return { error: 'day is not a real date' };
    return { scope: { kind: 'day', day } };
  }

  if (ids) {
    const list = [...new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))];
    if (!list.length) return { error: 'session_ids was empty' };
    if (list.length > MAX_SCOPE_LIVES) {
      return { error: `at most ${MAX_SCOPE_LIVES} lives per run, got ${list.length}` };
    }
    const bad = list.find((s) => !UUID_RE.test(s));
    if (bad) return { error: `session_ids contains a non-UUID: ${bad}` };
    return { scope: { kind: 'lives', sessionIds: list } };
  }

  return { scope: { kind: 'all' } };
}

/** The UTC window a fulfilment day covers: 04:00 local to 04:00 local the next day. */
export function dayWindow(day: string): { fromISO: string; toISO: string } {
  const { startMs, endMs } = zonedDayRangeUtcMs(day);
  return { fromISO: new Date(startMs).toISOString(), toISO: new Date(endMs).toISOString() };
}

/** Which fulfilment day a timestamp belongs to. */
export function dayOf(utcMs: number): string {
  return zonedDayKey(utcMs, SHOP_TIMEZONE);
}

/** Human label for a scope, for logs and the run summary. */
export function describeScope(scope: LabelScope): string {
  if (scope.kind === 'day') return `day ${scope.day}`;
  if (scope.kind === 'lives') return `${scope.sessionIds.length} live(s)`;
  return 'entire backlog';
}
