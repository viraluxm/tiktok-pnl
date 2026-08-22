// Timezone helpers for scheduling. The whole app operates in ONE business timezone,
// America/Los_Angeles, as a SERVER-FIXED constant (same as the time-clock RPCs in 071 and
// the PnL RPCs) — never a per-store column, never client-supplied. These convert between an
// LA-local wall-clock date/time and a UTC instant using the built-in Intl database, so no
// tz dependency is needed and DST is handled correctly.

export const BUSINESS_TZ = 'America/Los_Angeles';

// The offset (ms) of `date` in `tz`: (that wall-clock time read as UTC) − (the real instant).
// LA is behind UTC, so this is negative (e.g. −7h in PDT, −8h in PST).
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  // Intl renders hour '24' at midnight in some engines; normalize to 0.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

// The UTC instant for an LA-local wall-clock date + time-of-day. Two-pass so the correction is
// right across DST changes (the offset at the naive guess can differ from the offset at the
// corrected instant near a transition). `timeHHMMSS` accepts 'HH:MM' or 'HH:MM:SS'.
export function laWallTimeToUtc(dateISO: string, timeHHMMSS: string): Date {
  const [y, mo, d] = dateISO.slice(0, 10).split('-').map(Number);
  const [h, mi, s] = timeHHMMSS.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
  const off1 = tzOffsetMs(new Date(guess), BUSINESS_TZ);
  let utc = guess - off1;
  const off2 = tzOffsetMs(new Date(utc), BUSINESS_TZ);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

// The INVERSE of laWallTimeToUtc: the LA-local calendar date + minute-of-day for an instant.
// Same Intl mechanism and same pinned zone, so the pair round-trips (laWallTimeToUtc → this →
// laWallTimeToUtc is the identity at minute granularity, asserted in shifts/punchEdit.test.mjs).
// `time` is 'HH:MM' — MINUTE granularity, matching the <input type="time"> the operator edits and
// the date_trunc('minute', …) the punch RPCs write into start_time/end_time. Seconds are
// deliberately dropped: callers that must not lose a punch's sub-minute precision compare minute
// values and leave the instant untouched rather than rewriting it (see buildShiftEditPatch).
export function laWallClockOf(instant: Date | string): { date: string; time: string } {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  // Intl renders hour '24' at midnight in some engines; normalize to '00' (same fix as tzOffsetMs).
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

// Today's LA-local calendar date as 'YYYY-MM-DD'. Correct on both a UTC server (Vercel) and an
// LA dev machine, because it reads the date through the business timezone, not the host's.
export function laTodayISO(now: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Add `n` days to a 'YYYY-MM-DD' calendar date, returning 'YYYY-MM-DD'. Pure calendar
// arithmetic in UTC-midnight space (no DST/local drift) — dates are calendar labels here,
// not instants; the instant is derived later via laWallTimeToUtc.
export function addDaysISO(dateISO: string, n: number): string {
  const [y, mo, d] = dateISO.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// getUTCDay()-style weekday (0=Sun … 6=Sat) for a 'YYYY-MM-DD' calendar date — the SAME
// convention shift_rules.days_of_week and shift_templates.day_of_week use.
export function weekdayOf(dateISO: string): number {
  const [y, mo, d] = dateISO.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
