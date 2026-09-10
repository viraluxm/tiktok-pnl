import { BUSINESS_TZ, addDaysISO, weekdayOf } from './timezone';
import { weekBoundsMonSun } from './hours';
import type { PortalShift, PortalSnapshot, TradeView, TimeOffView, PickupRequestView } from './portalTypes';

// Pure view-model kernels for the employee portal. No React, no Supabase. Every decision the UI
// makes that could be wrong in an interesting way — which shift is "next", what day the strip
// selects, which alerts show, how hours print — lives here so portalModel.test.mjs can pin it.
//
// Instants are compared as epoch millis; calendar labels are LA-local via the Intl database
// (same discipline as timezone.ts / format.ts). Nothing here reads Date.now() itself: callers pass
// `nowMs`, so a test can stand anywhere in time.

// ── Greeting ─────────────────────────────────────────────────────────────────────────────────

/** LA-local hour (0–23) of an instant. */
export function laHourOf(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return h === 24 ? 0 : h;
}

export function firstNameOf(name: string): string {
  const first = (name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

export function greetingFor(hourLA: number, name: string): string {
  const who = firstNameOf(name);
  if (hourLA < 5) return `Still up, ${who}?`;
  if (hourLA < 12) return `Good morning, ${who}`;
  if (hourLA < 17) return `Good afternoon, ${who}`;
  return `Good evening, ${who}`;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

const DOW_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ymd(dateISO: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

/** 'MON' for a calendar date. */
export function dowShort(dateISO: string): string {
  return DOW_SHORT[weekdayOf(dateISO)];
}
/** 'Monday' for a calendar date. */
export function dowLong(dateISO: string): string {
  return DOW_LONG[weekdayOf(dateISO)];
}
/** 7 → '7' (the strip's day number). */
export function dayNumber(dateISO: string): number {
  return ymd(dateISO).d;
}
/** 'Sep 8' */
export function fmtMonthDay(dateISO: string): string {
  const { y, m, d } = ymd(dateISO);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** 'Tuesday, September 8' */
export function fmtLongDate(dateISO: string): string {
  const { y, m, d } = ymd(dateISO);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}
/** 'Tue, Sep 8' */
export function fmtShortDate(dateISO: string): string {
  const { y, m, d } = ymd(dateISO);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}
/** LA calendar date of an instant. */
export function laDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}
/** '6:00 PM' in LA. */
export function fmtTimeLA(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
/** '6:00 PM – 2:00 AM' (en dash, spaced — readable at a glance on a phone). */
export function fmtRangeLA(startISO: string, endISO: string): string {
  return `${fmtTimeLA(startISO)} – ${fmtTimeLA(endISO)}`;
}
/** True when the end lands on a later LA calendar day than the start. */
export function crossesMidnightLA(startISO: string, endISO: string): boolean {
  return laDateOf(endISO) > laDateOf(startISO);
}
/**
 * '40 hrs' / '31.5 hrs' / '8.25 hrs' — trailing zeros dropped, at most two decimals. Used for
 * BOTH scheduled and worked totals so the two never differ in format, only in label.
 */
export function fmtHours(h: number): string {
  const n = Math.round(h * 100) / 100;
  const s = Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '');
  return `${s} hr${n === 1 ? '' : 's'}`;
}
/** '8h 06m' — the timecard's per-punch duration. */
export function fmtDuration(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh}h ${String(mm).padStart(2, '0')}m`;
}

/** 'Today' | 'Tomorrow' | 'Thursday' (the weekday for anything else). */
export function relativeDayLabel(dateISO: string, todayISO: string): string {
  if (dateISO === todayISO) return 'Today';
  if (dateISO === addDaysISO(todayISO, 1)) return 'Tomorrow';
  if (dateISO === addDaysISO(todayISO, -1)) return 'Yesterday';
  return dowLong(dateISO);
}

// ── Next shift ───────────────────────────────────────────────────────────────────────────────

export interface NextShift {
  shift: PortalShift;
  /** 'now' = started and not ended; 'today'/'tomorrow'/'later' otherwise. */
  when: 'now' | 'today' | 'tomorrow' | 'later';
  /** Minutes until start (negative once started). */
  minutesUntil: number;
}

/**
 * The shift that matters most right now: the one in progress, else the first that has not ended.
 * A shift whose end has passed is never "next", even if the day is still today.
 */
export function pickNextShift(upcoming: readonly PortalShift[], nowMs: number, todayISO: string): NextShift | null {
  const live = [...upcoming]
    .filter((s) => Date.parse(s.ends_at) > nowMs)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const shift = live[0];
  if (!shift) return null;
  const startMs = Date.parse(shift.starts_at);
  const minutesUntil = Math.round((startMs - nowMs) / 60_000);
  let when: NextShift['when'];
  if (startMs <= nowMs) when = 'now';
  else if (shift.shift_date === todayISO) when = 'today';
  else if (shift.shift_date === addDaysISO(todayISO, 1)) when = 'tomorrow';
  else when = 'later';
  return { shift, when, minutesUntil };
}

/** 'Starts in 20 min' / 'Starts in 3 hrs' / 'In progress' — the small line under the time. */
export function nextShiftHint(next: NextShift): string {
  if (next.when === 'now') return 'In progress';
  const m = next.minutesUntil;
  if (m < 60) return `Starts in ${m} min`;
  if (m < 24 * 60) {
    const h = Math.round(m / 60);
    return `Starts in ${h} hr${h === 1 ? '' : 's'}`;
  }
  return '';
}

/**
 * The [start−45m, end+60m] window the clock gate enforces server-side (/s/[token]/clock). The
 * client uses the same predicate so it only ever offers a clock button the server would honour.
 */
export function inClockWindow(shift: Pick<PortalShift, 'starts_at' | 'ends_at'>, nowMs: number): boolean {
  return nowMs >= Date.parse(shift.starts_at) - 45 * 60_000 && nowMs <= Date.parse(shift.ends_at) + 60 * 60_000;
}

// ── Week strip ───────────────────────────────────────────────────────────────────────────────

export interface WeekStripCell {
  date: string;
  dow: string; // 'MON'
  day: number; // 7
  isToday: boolean;
  isSelected: boolean;
  isPast: boolean;
  hasShift: boolean;
  /** this cell holds the NEXT shift (the one Home leads with) */
  isNext: boolean;
  /** the shift on this day is offered (still mine) */
  isOffered: boolean;
}

export function weekStripModel(input: {
  weekStart: string; // a Monday
  todayISO: string;
  selected: string;
  shiftsByDate: ReadonlyMap<string, Pick<PortalShift, 'offer_state'>>;
  nextShiftDate: string | null;
}): WeekStripCell[] {
  const out: WeekStripCell[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(input.weekStart, i);
    const s = input.shiftsByDate.get(date);
    out.push({
      date,
      dow: dowShort(date),
      day: dayNumber(date),
      isToday: date === input.todayISO,
      isSelected: date === input.selected,
      isPast: date < input.todayISO,
      hasShift: !!s,
      isNext: input.nextShiftDate === date,
      isOffered: s?.offer_state === 'offered',
    });
  }
  return out;
}

/** The Monday of the week containing `dateISO`. */
export function mondayOf(dateISO: string): string {
  return weekBoundsMonSun(dateISO).start;
}

/**
 * How the shown week relates to the ACTUAL current business week. Only the week that contains
 * today (LA) is "This week"; the neighbours are named; anything further away gets no label. The
 * strip header prints this beside the date range so a past week can never read as the current one.
 */
export function weekLabel(weekStart: string, todayISO: string): 'This week' | 'Last week' | 'Next week' | null {
  const current = mondayOf(todayISO);
  if (weekStart === current) return 'This week';
  if (weekStart === addDaysISO(current, -7)) return 'Last week';
  if (weekStart === addDaysISO(current, 7)) return 'Next week';
  return null;
}

/**
 * Which day the strip should select when a week is shown: today when it is in this week, else the
 * first day with a shift, else the Monday. Never a day the user did not ask for when they did ask.
 */
export function defaultSelectedDay(weekStart: string, todayISO: string, shiftDates: ReadonlySet<string>): string {
  const end = addDaysISO(weekStart, 6);
  if (todayISO >= weekStart && todayISO <= end) return todayISO;
  for (let i = 0; i < 7; i++) {
    const d = addDaysISO(weekStart, i);
    if (shiftDates.has(d)) return d;
  }
  return weekStart;
}

/** A 'YYYY-MM-DD' that round-trips (rejects 2026-02-31, which Date.parse would roll over). */
export function isValidDateISO(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = ymd(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── Scheduled hours ──────────────────────────────────────────────────────────────────────────

/** Planned hours from shift_instances inside [start, end]. Scheduled ONLY — never a pay figure. */
export function scheduledHoursBetween(shifts: readonly Pick<PortalShift, 'shift_date' | 'hours'>[], start: string, end: string): number {
  return shifts.filter((s) => s.shift_date >= start && s.shift_date <= end).reduce((sum, s) => sum + s.hours, 0);
}

// ── Alerts (Home) ────────────────────────────────────────────────────────────────────────────

export type AlertKind =
  | 'trade_incoming'
  | 'pickup_waiting'
  | 'offered_still_yours'
  | 'trade_waiting_manager'
  | 'time_off_decided'
  | 'trade_decided'
  | 'pickup_decided'
  | 'open_shifts';

export interface Alert {
  id: string;
  kind: AlertKind;
  title: string;
  body?: string;
  /** true when the employee has to DO something */
  actionable: boolean;
  /** where tapping goes */
  go: { tab: 'requests' } | { tab: 'schedule'; seg: 'mine' | 'team' | 'open' };
}

const RECENT_DAYS = 7;

function withinDays(iso: string | null, nowMs: number, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t <= days * 86_400_000 && t <= nowMs + 60_000;
}

/**
 * Contextual alerts, most urgent first. Only real conditions produce an alert — there is never an
 * empty placeholder for a request type that has nothing going on.
 */
export function buildAlerts(snap: PortalSnapshot, nowMs: number): Alert[] {
  const out: Alert[] = [];
  const dayOf = (s: { shift_date: string }) => relativeDayLabel(s.shift_date, snap.todayISO);

  for (const t of snap.trades) {
    if (t.direction === 'incoming' && t.status === 'pending_coworker') {
      out.push({
        id: `trade-in-${t.id}`,
        kind: 'trade_incoming',
        title: `${firstNameOf(t.other_name)} sent you a trade request`,
        body: `Your ${dayOf(t.my_shift)} shift for their ${dayOf(t.their_shift)} shift.`,
        actionable: true,
        go: { tab: 'requests' },
      });
    }
  }
  for (const s of snap.upcoming) {
    if (s.offer_state === 'offered') {
      out.push({
        id: `offered-${s.id}`,
        kind: 'offered_still_yours',
        title: `Your ${dayOf(s)} shift is offered`,
        body: 'You are still responsible for it until a manager approves someone else.',
        actionable: false,
        go: { tab: 'schedule', seg: 'mine' },
      });
    }
  }
  const pendingPickups = snap.pickups.filter((p) => p.status === 'pending');
  if (pendingPickups.length > 0) {
    out.push({
      id: 'pickups-pending',
      kind: 'pickup_waiting',
      title: pendingPickups.length === 1
        ? `Pickup for ${dayOf(pendingPickups[0])} is waiting for manager approval`
        : `${pendingPickups.length} pickups are waiting for manager approval`,
      body: 'Not yours until it is approved.',
      actionable: false,
      go: { tab: 'requests' },
    });
  }
  for (const t of snap.trades) {
    if (t.status === 'pending_manager') {
      out.push({
        id: `trade-mgr-${t.id}`,
        kind: 'trade_waiting_manager',
        title: `Trade with ${firstNameOf(t.other_name)} is waiting for manager approval`,
        actionable: false,
        go: { tab: 'requests' },
      });
    }
  }
  for (const r of snap.timeOff) {
    if (r.status !== 'pending' && withinDays(r.decided_at, nowMs, RECENT_DAYS)) {
      out.push({
        id: `timeoff-${r.id}`,
        kind: 'time_off_decided',
        title: `Your time off ${r.start_date === r.end_date ? fmtMonthDay(r.start_date) : `${fmtMonthDay(r.start_date)} – ${fmtMonthDay(r.end_date)}`} was ${r.status}`,
        body: r.decision_note ?? undefined,
        actionable: false,
        go: { tab: 'requests' },
      });
    }
  }
  for (const t of snap.trades) {
    if ((t.status === 'approved' || t.status === 'declined') && withinDays(t.decided_at ?? t.coworker_responded_at, nowMs, RECENT_DAYS)) {
      out.push({
        id: `trade-done-${t.id}`,
        kind: 'trade_decided',
        title: t.status === 'approved'
          ? `Trade with ${firstNameOf(t.other_name)} was approved`
          : `Trade with ${firstNameOf(t.other_name)} was declined`,
        actionable: false,
        go: { tab: 'requests' },
      });
    }
  }
  for (const p of snap.pickups) {
    if (p.status !== 'pending' && withinDays(p.decided_at, nowMs, RECENT_DAYS)) {
      out.push({
        id: `pickup-done-${p.claim_id}`,
        kind: 'pickup_decided',
        title: p.status === 'approved'
          ? `Your ${dayOf(p)} pickup was approved`
          : p.status === 'superseded'
            ? `Someone else got the ${dayOf(p)} shift`
            : `Your ${dayOf(p)} pickup was not approved`,
        actionable: false,
        go: { tab: 'requests' },
      });
    }
  }
  const openCount = snap.available.filter((a) => !a.refusal && !a.requested).length;
  if (openCount > 0) {
    out.push({
      id: 'open-shifts',
      kind: 'open_shifts',
      title: `${openCount} open shift${openCount === 1 ? '' : 's'} available`,
      actionable: false,
      go: { tab: 'schedule', seg: 'open' },
    });
  }
  return out;
}

// ── Requests screen grouping ─────────────────────────────────────────────────────────────────

export type RequestItem =
  | { key: string; kind: 'trade'; trade: TradeView; at: string }
  | { key: string; kind: 'time_off'; request: TimeOffView; at: string }
  | { key: string; kind: 'pickup'; pickup: PickupRequestView; at: string }
  | { key: string; kind: 'ot_claim'; claim: PortalSnapshot['otClaims'][number]; at: string };

export interface RequestGroups {
  /** the employee must act (accept/decline an incoming trade) */
  action: RequestItem[];
  /** waiting on someone else */
  pending: RequestItem[];
  /** decided, newest first */
  history: RequestItem[];
}

export function groupRequests(snap: PortalSnapshot): RequestGroups {
  const action: RequestItem[] = [];
  const pending: RequestItem[] = [];
  const history: RequestItem[] = [];

  for (const t of snap.trades) {
    const item: RequestItem = { key: `trade-${t.id}`, kind: 'trade', trade: t, at: t.decided_at ?? t.cancelled_at ?? t.coworker_responded_at ?? t.created_at };
    if (t.status === 'pending_coworker' && t.direction === 'incoming') action.push(item);
    else if (t.status === 'pending_coworker' || t.status === 'pending_manager') pending.push(item);
    else history.push(item);
  }
  for (const r of snap.timeOff) {
    const item: RequestItem = { key: `to-${r.id}`, kind: 'time_off', request: r, at: r.decided_at ?? r.created_at };
    if (r.status === 'pending') pending.push(item); else history.push(item);
  }
  for (const p of snap.pickups) {
    const item: RequestItem = { key: `pk-${p.claim_id}`, kind: 'pickup', pickup: p, at: p.decided_at ?? p.requested_at };
    if (p.status === 'pending') pending.push(item); else history.push(item);
  }
  for (const c of snap.otClaims) {
    pending.push({ key: `ot-${c.claim_id}`, kind: 'ot_claim', claim: c, at: c.starts_at });
  }

  const byAtAsc = (a: RequestItem, b: RequestItem) => Date.parse(a.at) - Date.parse(b.at);
  const byAtDesc = (a: RequestItem, b: RequestItem) => Date.parse(b.at) - Date.parse(a.at);
  action.sort(byAtAsc);
  pending.sort(byAtAsc);
  history.sort(byAtDesc);
  return { action, pending, history };
}

/** Count for the Requests tab badge: only things the employee has to act on. */
export function actionCount(snap: PortalSnapshot): number {
  return groupRequests(snap).action.length;
}

// ── Status words ─────────────────────────────────────────────────────────────────────────────

export function tradeStatusWords(t: TradeView): string {
  const who = firstNameOf(t.other_name);
  switch (t.status) {
    case 'pending_coworker': return t.direction === 'outgoing' ? `Waiting for ${who}` : 'Needs your answer';
    case 'pending_manager': return 'Waiting for manager approval';
    case 'approved': return 'Approved';
    case 'declined': return t.coworker_response === 'declined' ? `Declined by ${who}` : 'Declined by manager';
    case 'cancelled': return 'Cancelled';
  }
}

export function timeOffStatusWords(r: TimeOffView): string {
  switch (r.status) {
    case 'pending': return 'Pending manager approval';
    case 'approved': return 'Approved';
    case 'denied': return 'Declined';
  }
}

export function pickupStatusWords(p: PickupRequestView): string {
  switch (p.status) {
    case 'pending': return 'Waiting for manager approval';
    case 'approved': return 'Approved';
    case 'rejected': return 'Not approved';
    case 'superseded': return 'Went to someone else';
  }
}

/** 'Live Host' / 'Fulfillment' — the employee-facing role label. */
export function roleLabel(role: string | null | undefined): string {
  const r = (role ?? '').trim().toLowerCase();
  if (r === 'host' || r === 'live host') return 'Live Host';
  if (r === 'fulfillment') return 'Fulfillment';
  if (!r) return '';
  return r.replace(/\b\w/g, (c) => c.toUpperCase());
}
