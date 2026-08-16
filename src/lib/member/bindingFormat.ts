import { BUSINESS_TZ } from '@/lib/schedule/timezone';
import type { SessionDistance } from '@/lib/member/sessionDistance';

// Display formatting for the binding page (O1).
//
// Every timestamp on /team/binding renders in the business timezone by NAMED zone, with an
// explicit locale. The page previously called toLocaleDateString(undefined, …) / toLocaleString(
// undefined, …) with no `timeZone`, so it rendered in the BROWSER's zone and locale — the only
// surface in the app that did. A screenshot from a UTC+8 workstation showed a session window of
// "10 Aug, 9:17 → 10 Aug, 18:02" for a show that actually ran Aug 9 18:17 → Aug 10 03:02 Pacific,
// which made a correct 6-minute rejection look like a bug.
//
// Rules enforced here, and covered by roomLive-style tests under three host timezones:
//   • timeZone is always BUSINESS_TZ (a NAMED zone — DST-correct, never a fixed offset).
//   • the locale is always explicit ('en-US') — never `undefined`, which follows the browser.
//   • the zone label is rendered ('PDT'/'PST') so an operator abroad knows what they are reading.
// BUSINESS_TZ is the codebase's canonical business-timezone constant (src/lib/schedule/timezone.ts);
// there is no pre-existing shared instant FORMATTER to reuse — see the change summary.

const LOCALE = 'en-US';

const partsOf = (ms: number, opts: Intl.DateTimeFormatOptions): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TZ, ...opts }).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return out;
};

const DATE_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** Pacific calendar date as YYYY-MM-DD — used to detect a window crossing midnight. */
export function ptDateKey(iso: string | null): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** "Aug 9, 6:10 PM PDT" — the full instant. Used wherever a single timestamp is shown. */
export function fmtInstantPT(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '—';
  const p = partsOf(ms, { ...DATE_OPTS, ...TIME_OPTS, timeZoneName: 'short' });
  return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/** "6:10 PM" — time only, for the end of a window already carrying its date. */
function fmtTimeOnlyPT(ms: number): string {
  const p = partsOf(ms, TIME_OPTS);
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * A session window. When start and end fall on the SAME Pacific date the end is time-only:
 *   "Aug 9, 6:17 PM → 11:40 PM PDT"
 * When the window crosses midnight Pacific the end repeats its date AND carries an explicit
 * day-offset marker, so it can never be misread as same-day:
 *   "Aug 9, 6:17 PM → Aug 10, 3:02 AM PDT (+1d)"
 * An open session renders "→ ongoing".
 */
export function fmtWindowPT(startIso: string | null, endIso: string | null): string {
  const sMs = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(sMs)) return '—';
  const sp = partsOf(sMs, { ...DATE_OPTS, ...TIME_OPTS });
  const head = `${sp.month} ${sp.day}, ${sp.hour}:${sp.minute} ${sp.dayPeriod}`;

  const eMs = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(eMs)) {
    const zone = partsOf(sMs, { timeZoneName: 'short' }).timeZoneName;
    return `${head} ${zone} → ongoing`;
  }

  const zone = partsOf(eMs, { timeZoneName: 'short' }).timeZoneName;
  const sKey = ptDateKey(startIso);
  const eKey = ptDateKey(endIso);
  if (sKey && eKey && sKey === eKey) return `${head} → ${fmtTimeOnlyPT(eMs)} ${zone}`;

  const ep = partsOf(eMs, { ...DATE_OPTS, ...TIME_OPTS });
  const days = sKey && eKey
    ? Math.round((Date.parse(`${eKey}T00:00:00Z`) - Date.parse(`${sKey}T00:00:00Z`)) / 86_400_000)
    : 0;
  const marker = days > 0 ? ` (+${days}d)` : '';
  return `${head} → ${ep.month} ${ep.day}, ${ep.hour}:${ep.minute} ${ep.dayPeriod} ${zone}${marker}`;
}

/** "45 s" / "6 min" / "2 h 5 min" / "1 d 3 h" — coarse, magnitude-appropriate. */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/**
 * "6 min before start" / "2 h after end" / "in window". Direction is always explicit.
 * Returns null when the distance is unknown, so the caller renders nothing.
 */
export function fmtDistance(d: SessionDistance | null | undefined): string | null {
  if (!d) return null;
  if (d.direction === 'within') return 'in window';
  const dir = d.direction === 'before_start' ? 'before start' : 'after end';
  return `${fmtDuration(d.seconds)} ${dir}`;
}
