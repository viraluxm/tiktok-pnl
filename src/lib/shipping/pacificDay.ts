// Start of the current Pacific calendar day, as an instant.
//
// NO IMPORTS — pacificDay.test.mjs transpiles this file standalone at runtime.
//
// The business runs on one fixed timezone (see CLAUDE.md), so "today" is a Pacific calendar
// day rather than a rolling 24 hours: a rolling window would quietly drop this morning's boxes
// as the afternoon wore on, and the number on a picker's screen would go DOWN while they
// worked.
//
// A hardcoded -07:00 or -08:00 would be an hour wrong for part of the year, so the offset is
// resolved on the day in question.

const TZ = 'America/Los_Angeles';

/** The Pacific calendar date of an instant, as YYYY-MM-DD. */
export function pacificDate(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, so the date can be read off rather than reassembled.
  return at.toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * The instant at which the given Pacific day began.
 *
 * Two steps, because the offset itself depends on the answer: guess that Pacific midnight is
 * UTC midnight, measure how far the zone's wall clock actually sits from UTC at that guess,
 * then shift by exactly that much. One correction is sufficient — the error is always a whole
 * number of hours and never large enough to cross into a different offset regime.
 */
export function pacificDayStart(at: Date = new Date()): Date {
  const ymd = pacificDate(at);
  const guess = new Date(`${ymd}T00:00:00Z`);
  // sv-SE formats as "YYYY-MM-DD HH:mm:ss" — parseable once the space becomes a T. Reading it
  // back as if it were UTC yields the wall-clock time as an instant, and the difference from
  // the guess is the zone's offset.
  const wall = new Date(`${guess.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')}Z`);
  return new Date(guess.getTime() + (guess.getTime() - wall.getTime()));
}
