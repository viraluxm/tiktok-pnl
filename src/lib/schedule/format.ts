import { BUSINESS_TZ } from './timezone';

// Display formatting for the employee-facing pages. Instants (timestamptz) render in the business
// timezone; plain calendar dates ('YYYY-MM-DD') render in UTC so the label never drifts a day.

export function fmtDateLA(instantISO: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(instantISO));
}

export function fmtTimeRangeLA(startISO: string, endISO: string): string {
  const f = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return `${f(startISO)}–${f(endISO)}`;
}

// True when the shift's end lands on a LATER LA calendar day than its start (e.g. 4pm–2am,
// 5pm–1am). Drives the "🌙 +1d" overnight marker — the same convention the team-tab weekly
// calendar uses (ShiftCard.tsx). Compares LA-local calendar dates of the two instants.
export function isOvernight(startsISO: string, endsISO: string): boolean {
  const laDate = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
  return laDate(endsISO) > laDate(startsISO);
}

// A plain calendar date label, e.g. period end 'Mon, Aug 24'.
export function fmtCalendarDate(dateISO: string): string {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
