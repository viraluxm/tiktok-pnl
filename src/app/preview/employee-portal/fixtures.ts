// In-memory world for /preview/employee-portal. PURE DATA + PURE LOGIC — no imports that can reach
// a database or the network. It implements the same PortalClient interface the real page uses, so
// every screen, sheet and state of the shipping components is reviewable with ZERO network path.
//
// Cast: Carlos (Live Host) is the default viewer; Juan (Live Host) is the coworker on the other
// side of the trade and the pickup; Adriana (Live Host) offers a shift; Madison and Ana are
// Fulfillment — Madison is the third viewer, so Team can be reviewed from the other team's side.

import type {
  AvailableItem, PortalClient as _PC, PortalShift, PortalSnapshot, PortalTeamShift, PortalWeek, TimecardPayload, TradeOptionsPayload, TradeView, TimeOffView, PickupRequestView,
} from './types';
import { addDaysISO } from '@/lib/schedule/timezone';
import { weekBoundsMonSun, instanceHours } from '@/lib/schedule/hours';
import { payPeriodContaining } from '@/lib/employees';
import { buildTimecard, type TimecardShiftRow } from '@/lib/schedule/timecardModel';
import { buildCalendarDays, type DayPerson } from '@/lib/schedule/calendarModel';
import { buildTradeOptions, planTradeRequest, otherDates, TRADE_REFUSAL_MESSAGES, type TradeableInstance } from '@/lib/schedule/tradePlan';
import { laTodayISO } from '@/lib/schedule/timezone';

export type PortalClient = _PC;

export interface DemoEmployee { id: string; name: string; role: 'host' | 'fulfillment'; status: 'active' }
export interface DemoInstance {
  id: string; employee_id: string; shift_date: string; starts_at: string; ends_at: string;
  status: 'scheduled' | 'claimed' | 'released'; released_by: string | null; role: 'host' | 'fulfillment';
  offer_state: 'offered' | 'transferred' | 'closed' | null; offer_id: string | null;
}
export interface DemoPickup { claim_id: string; shift_instance_id: string; claimed_by: string; offer_id: string | null; status: 'pending' | 'approved' | 'rejected' | 'superseded'; requested_at: string; decided_at: string | null }
export interface DemoTrade {
  id: string; requester_employee_id: string; requester_shift_instance_id: string; target_employee_id: string; target_shift_instance_id: string;
  status: TradeView['status']; coworker_response: 'accepted' | 'declined' | null; coworker_responded_at: string | null; decided_at: string | null; decision_note: string | null; cancelled_at: string | null; created_at: string;
}
export interface DemoTimeOff { id: string; employee_id: string; start_date: string; end_date: string; reason: string | null; status: 'pending' | 'approved' | 'denied'; decision_note: string | null; created_at: string; decided_at: string | null }
/** A punch awaiting (or holding) a manager's approval, for the confirmation tiles. */
export interface DemoConfirmable {
  id: string;
  employee_id: string;
  date: string;
  start_time: string;
  end_time: string;
  clock_in_at: string;
  clock_out_at: string;
  break_minutes: number;
  confirmed_at: string | null;
  approved_minutes: number | null;
}

export interface DemoWorld {
  viewerId: string;
  employees: DemoEmployee[];
  instances: DemoInstance[];
  pickups: DemoPickup[];
  trades: DemoTrade[];
  timeOff: DemoTimeOff[];
  punches: TimecardShiftRow[];
  /** the manager's confirmation queue (separate from the viewer's own timecard rows) */
  confirmable: DemoConfirmable[];
  clockedInAt: string | null;
  log: string[];
}

// ── dates relative to today, pinned to LA ────────────────────────────────────────────────────
const today = laTodayISO();
const d = (offset: number) => addDaysISO(today, offset);
// LA wall-clock → instant. The preview's dates are all within a week or two of today, so a fixed
// -07:00 (PDT) is right through Nov 1; this is preview data, not payroll.
const at = (dateISO: string, hour: number, minute = 0) => new Date(`${dateISO}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-07:00`).toISOString();
const week = weekBoundsMonSun(today);
const dow = (n: number) => addDaysISO(week.start, n); // 0 = Mon of this week

export const CARLOS = 'emp-carlos', JUAN = 'emp-juan', ADRIANA = 'emp-adriana', MADISON = 'emp-madison', ANA = 'emp-ana';

function inst(id: string, emp: string, date: string, sh: number, eh: number, role: 'host' | 'fulfillment', extra: Partial<DemoInstance> = {}): DemoInstance {
  const endDate = eh <= sh ? addDaysISO(date, 1) : date;
  return { id, employee_id: emp, shift_date: date, starts_at: at(date, sh), ends_at: at(endDate, eh), status: 'scheduled', released_by: null, role, offer_state: null, offer_id: null, ...extra };
}

export function initialWorld(): DemoWorld {
  const hostEve = (id: string, emp: string, date: string, extra?: Partial<DemoInstance>) => inst(id, emp, date, 18, 2, 'host', extra);
  const fulDay = (id: string, emp: string, date: string, extra?: Partial<DemoInstance>) => inst(id, emp, date, 6, 14, 'fulfillment', extra);
  const instances: DemoInstance[] = [
    // Carlos — today (evening), Thu, Sat this week; next week Tue/Thu
    hostEve('c-today', CARLOS, today),
    hostEve('c-thu', CARLOS, dow(3)),
    hostEve('c-sat', CARLOS, dow(5)),
    hostEve('c-n-tue', CARLOS, dow(8)),
    hostEve('c-n-thu', CARLOS, dow(10)),
    // Juan — Fri + Sun this week (mornings), next week Mon/Wed
    inst('j-fri', JUAN, dow(4), 6, 14, 'host'),
    inst('j-sun', JUAN, dow(6), 6, 14, 'host'),
    inst('j-n-mon', JUAN, dow(7), 6, 14, 'host'),
    inst('j-n-wed', JUAN, dow(9), 6, 14, 'host'),
    // Adriana — Mon, Tue, Fri evenings; Friday is OFFERED (Carlos can pick it up)
    hostEve('a-mon', ADRIANA, dow(0)),
    hostEve('a-tue', ADRIANA, dow(1)),
    hostEve('a-fri', ADRIANA, dow(4), { offer_state: 'offered', offer_id: 'offer-a-fri' }),
    hostEve('a-n-mon', ADRIANA, dow(7)),
    // Fulfillment — Madison Mon–Fri, Ana Wed–Sun; Ana's Saturday is offered (wrong role for Carlos)
    ...[0, 1, 2, 3, 4].map((n) => fulDay(`m-${n}`, MADISON, dow(n))),
    ...[2, 3, 4, 6].map((n) => fulDay(`n-${n}`, ANA, dow(n))),
    fulDay('n-5', ANA, dow(5), { offer_state: 'offered', offer_id: 'offer-n-5' }),
  ];
  // Filter out Carlos's "today" shift if today is one of the dow() days already used to avoid UNIQUE(employee, date) clashes.
  const seen = new Set<string>();
  const unique = instances.filter((i) => { const k = `${i.employee_id}|${i.shift_date}`; if (seen.has(k)) return false; seen.add(k); return true; });

  // APPROVED HOURS (migration 137). The viewer is a LIVE HOST, so their approved duration is the
  // verified live time — deliberately SHORTER than the clocked span, which is the case the portal
  // has to explain. `approved_minutes: null` on one row shows the legacy fallback beside it.
  const punch = (id: string, date: string, inH: number, inM: number, outDate: string, outH: number, outM: number, extra: Partial<TimecardShiftRow> = {}): TimecardShiftRow => ({
    id, employee_id: CARLOS, date, start_time: `${String(inH).padStart(2, '0')}:${String(inM).padStart(2, '0')}:00`, end_time: `${String(outH).padStart(2, '0')}:${String(outM).padStart(2, '0')}:00`,
    source: 'time_clock', source_rule_id: null, confirmed_at: '2026-01-01T00:00:00Z', break_minutes: 0,
    clock_in_at: at(date, inH, inM), clock_out_at: at(outDate, outH, outM), auto_closed: false,
    approved_minutes: 478, ...extra,
  });
  // Last week: four confirmed evening punches. This week: one punch for every day already behind
  // us (so the week total is never empty after Monday), with the second left unconfirmed and the
  // third entered by a manager, so all three timecard states are visible.
  // PAST DAYS INSIDE THE CURRENT PAY PERIOD — the only days the timecard's two windows can show.
  // Early in a period there may be just one, so the states are STACKED as extra entries on the
  // newest day (a split shift, which the model already renders with a day total) rather than
  // placed on dates the screen would filter out. Every approval state stays reviewable on any
  // weekday: approved (the live-host case, shorter than clocked), AWAITING APPROVAL, and a LEGACY
  // confirmed row with no approval at all, whose clocked figure is what pays.
  const periodStart = payPeriodContaining(today).start;
  const pastInPeriod: string[] = [];
  for (let back = 1; back <= 14; back++) {
    const date = d(-back);
    if (date < periodStart) break;
    pastInPeriod.push(date);
  }
  // Each state gets its OWN realistic window, so stacked entries on one day read as a plausible
  // split shift rather than a 16-hour span.
  const specs: Array<{ inH: number; inM: number; outH: number; outM: number; overnight: boolean; extra: Partial<TimecardShiftRow> }> = [
    // The live-host case: clocked 8h05m, approved 7h58m — shorter, and the screen says why.
    { inH: 18, inM: 2, outH: 2, outM: 7, overnight: true, extra: { approved_minutes: 478 } },
    // Awaiting approval: the punch landed, no manager has confirmed it, so no figure is final.
    { inH: 6, inM: 0, outH: 10, outM: 0, overnight: false, extra: { confirmed_at: null, approved_minutes: null } },
    // Legacy: confirmed before approved hours existed. Its clocked figure (3h30m − 30m break) pays.
    { inH: 11, inM: 0, outH: 14, outM: 30, overnight: false, extra: { break_minutes: 30, approved_minutes: null } },
  ];
  const punches: TimecardShiftRow[] = pastInPeriod.length === 0 ? [] : specs.map((spec, i) => {
    const date = pastInPeriod[Math.min(i, pastInPeriod.length - 1)];
    return punch(`p-${i}`, date, spec.inH, spec.inM, spec.overnight ? addDaysISO(date, 1) : date, spec.outH, spec.outM, spec.extra);
  });

  const now = new Date().toISOString();
  return {
    viewerId: CARLOS,
    employees: [
      { id: CARLOS, name: 'Carlos Ruiz', role: 'host', status: 'active' },
      { id: JUAN, name: 'Juan Perez', role: 'host', status: 'active' },
      { id: ADRIANA, name: 'Adriana Cole', role: 'host', status: 'active' },
      { id: MADISON, name: 'Madison Lee', role: 'fulfillment', status: 'active' },
      { id: ANA, name: 'Ana Torres', role: 'fulfillment', status: 'active' },
    ],
    instances: unique,
    pickups: [
      // a pickup Carlos got last week (history)
      { claim_id: 'pk-hist', shift_instance_id: 'a-mon', claimed_by: CARLOS, offer_id: 'old', status: 'approved', requested_at: addDaysISO(today, -9) + 'T18:00:00Z', decided_at: addDaysISO(today, -8) + 'T09:00:00Z' },
    ],
    trades: [
      // Juan proposes: his Friday morning for Carlos's Thursday evening → NEEDS CARLOS'S ACTION
      { id: 'tr-in', requester_employee_id: JUAN, requester_shift_instance_id: 'j-fri', target_employee_id: CARLOS, target_shift_instance_id: 'c-thu', status: 'pending_coworker', coworker_response: null, coworker_responded_at: null, decided_at: null, decision_note: null, cancelled_at: null, created_at: now },
    ],
    timeOff: [
      { id: 'to-pending', employee_id: CARLOS, start_date: d(17), end_date: d(19), reason: 'Family trip', status: 'pending', decision_note: null, created_at: addDaysISO(today, -2) + 'T15:00:00Z', decided_at: null },
      { id: 'to-denied', employee_id: CARLOS, start_date: d(-20), end_date: d(-20), reason: null, status: 'denied', decision_note: 'Show night — we need everyone', created_at: addDaysISO(today, -30) + 'T15:00:00Z', decided_at: addDaysISO(today, -28) + 'T09:00:00Z' },
      { id: 'to-juan', employee_id: JUAN, start_date: d(24), end_date: d(25), reason: 'Wedding', status: 'pending', decision_note: null, created_at: addDaysISO(today, -1) + 'T15:00:00Z', decided_at: null },
    ],
    punches,
    // One LIVE HOST punch (must be given a figure) and one FULFILLMENT punch (prefilled with the
    // canonical clocked duration) — the two shapes a manager actually confirms.
    confirmable: [
      {
        id: 'cf-carlos', employee_id: CARLOS, date: d(-1), start_time: '17:48:00', end_time: '02:20:00',
        clock_in_at: at(d(-1), 17, 48), clock_out_at: at(d(0), 2, 20),
        break_minutes: 0, confirmed_at: null, approved_minutes: null,
      },
      {
        id: 'cf-madison', employee_id: MADISON, date: d(-1), start_time: '05:58:00', end_time: '14:04:00',
        clock_in_at: at(d(-1), 5, 58), clock_out_at: at(d(-1), 14, 4),
        break_minutes: 30, confirmed_at: null, approved_minutes: null,
      },
    ],
    clockedInAt: null,
    log: [],
  };
}

// ── projections: the same shapes the server builds ───────────────────────────────────────────

const nameOf = (w: DemoWorld, id: string) => w.employees.find((e) => e.id === id)?.name ?? 'Unknown';
const empOf = (w: DemoWorld, id: string) => w.employees.find((e) => e.id === id)!;
const LIVE = new Set(['pending_coworker', 'pending_manager']);

function tradeView(w: DemoWorld, t: DemoTrade, meId: string): TradeView {
  const mine = t.requester_employee_id === meId;
  const f = (id: string) => { const i = w.instances.find((x) => x.id === id)!; return { instance_id: i.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, hours: instanceHours(i.starts_at, i.ends_at) }; };
  return {
    id: t.id, status: t.status, direction: mine ? 'outgoing' : 'incoming',
    other_name: nameOf(w, mine ? t.target_employee_id : t.requester_employee_id),
    my_shift: f(mine ? t.requester_shift_instance_id : t.target_shift_instance_id),
    their_shift: f(mine ? t.target_shift_instance_id : t.requester_shift_instance_id),
    created_at: t.created_at, coworker_response: t.coworker_response, coworker_responded_at: t.coworker_responded_at,
    decided_at: t.decided_at, decision_note: t.decision_note, cancelled_at: t.cancelled_at,
  };
}

function toShift(w: DemoWorld, i: DemoInstance, meId: string): PortalShift {
  const t = w.trades.find((x) => LIVE.has(x.status) && (x.requester_shift_instance_id === i.id || x.target_shift_instance_id === i.id));
  return {
    id: i.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, status: i.status === 'claimed' ? 'claimed' : 'scheduled',
    role: i.role, hours: instanceHours(i.starts_at, i.ends_at), offer_state: i.offer_state, offer_id: i.offer_id,
    trade: t ? { id: t.id, status: t.status as 'pending_coworker' | 'pending_manager', with_name: nameOf(w, t.requester_employee_id === meId ? t.target_employee_id : t.requester_employee_id), i_am: t.requester_employee_id === meId ? 'requester' : 'target' } : null,
  };
}

function available(w: DemoWorld, meId: string): AvailableItem[] {
  const me = empOf(w, meId);
  const myDates = new Set(w.instances.filter((i) => i.employee_id === meId && i.status !== 'released').map((i) => i.shift_date));
  return w.instances
    .filter((i) => i.offer_state === 'offered' && i.employee_id !== meId && i.shift_date >= today && i.role === me.role)
    .map((i) => {
      const requested = w.pickups.some((p) => p.shift_instance_id === i.id && p.claimed_by === meId && p.status === 'pending');
      return {
        kind: 'offer' as const, id: i.id, offer_id: i.offer_id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, role: i.role,
        hours: instanceHours(i.starts_at, i.ends_at), offered_by_name: nameOf(w, i.employee_id),
        requested, refusal: !requested && myDates.has(i.shift_date) ? "You're already scheduled that day." : null,
      };
    });
}

export function snapshotFor(w: DemoWorld): PortalSnapshot {
  const meId = w.viewerId;
  const me = empOf(w, meId);
  const mine = w.instances.filter((i) => i.employee_id === meId && i.status !== 'released' && i.shift_date >= week.start).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((i) => toShift(w, i, meId));
  const tc = timecardFor(w);
  return {
    employee: { name: me.name, role: me.role, shortId: meId.slice(0, 8), status: 'active' },
    todayISO: today, generatedAt: new Date().toISOString(),
    upcoming: mine.filter((s) => s.shift_date >= today),
    releasedByMe: [],
    thisWeek: { start: week.start, end: week.end, scheduledHours: mine.filter((s) => s.shift_date <= week.end).reduce((s, x) => s + x.hours, 0), workedHours: tc.week.workedHours, pendingHours: tc.week.pendingHours },
    payPeriod: { start: tc.period.start, end: tc.period.end, workedHours: tc.period.workedHours, pendingHours: tc.period.pendingHours },
    clock: w.clockedInAt && meId === CARLOS ? { state: 'working', clockedInAt: w.clockedInAt } : { state: 'clocked_out', clockedInAt: null },
    available: available(w, meId),
    pickups: w.pickups.filter((p) => p.claimed_by === meId).map((p): PickupRequestView => { const i = w.instances.find((x) => x.id === p.shift_instance_id)!; return { claim_id: p.claim_id, shift_instance_id: i.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, status: p.status, requested_at: p.requested_at, decided_at: p.decided_at }; }),
    otClaims: [],
    timeOff: w.timeOff.filter((r) => r.employee_id === meId).map((r): TimeOffView => ({ id: r.id, start_date: r.start_date, end_date: r.end_date, reason: r.reason, status: r.status, decision_note: r.decision_note, created_at: r.created_at, decided_at: r.decided_at })),
    timeOffEarliest: addDaysISO(payPeriodContaining(d(3)).start, 14),
    trades: w.trades.filter((t) => t.requester_employee_id === meId || t.target_employee_id === meId).map((t) => tradeView(w, t, meId)),
    drops: { used: 0, cap: 2, excused: 0 },
  };
}

export function weekFor(w: DemoWorld, start: string): PortalWeek {
  const meId = w.viewerId;
  const days = Array.from({ length: 7 }, (_, n) => addDaysISO(start, n));
  return {
    start, end: days[6],
    days: days.map((date) => { const i = w.instances.find((x) => x.employee_id === meId && x.shift_date === date && x.status !== 'released'); return { date, shift: i ? toShift(w, i, meId) : null }; }),
    // TEAM SCOPE, mirroring teamSchedule.ts: only the viewer's own team ever appears.
    team: days.map((date) => ({
      date,
      shifts: w.instances.filter((i) => i.shift_date === date && i.status !== 'released' && empOf(w, i.employee_id).role === empOf(w, meId).role).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || nameOf(w, a.employee_id).localeCompare(nameOf(w, b.employee_id))).map((i): PortalTeamShift => ({
        instance_id: i.id, name: nameOf(w, i.employee_id), role: i.role, starts_at: i.starts_at, ends_at: i.ends_at, hours: instanceHours(i.starts_at, i.ends_at), offered: i.offer_state === 'offered', offer_id: i.offer_id, is_me: i.employee_id === meId,
      })),
    })),
  };
}

export function timecardFor(w: DemoWorld): TimecardPayload {
  // Madison is FULFILLMENT: her approved duration equals the canonical payable figure (the span
  // minus her unpaid break), which is the default a manager confirms at. Reviewing both viewers
  // shows the two shapes side by side without touching production data.
  const madisonPunches: TimecardShiftRow[] = w.punches
    .filter((p) => p.clock_in_at && p.date < today)
    .slice(0, 3)
    .map((p, i) => ({
      ...p, id: `m-${p.id}`, employee_id: MADISON,
      start_time: '06:00:00', end_time: '14:00:00',
      clock_in_at: at(p.date, 5, 58), clock_out_at: at(p.date, 14, 4),
      break_minutes: 30, confirmed_at: i === 0 ? null : '2026-01-01T00:00:00Z',
      approved_minutes: i === 0 ? null : 456, // 8h06m span − 30m break = 7h36m = 456
    }));
  return buildTimecard({
    shifts: w.viewerId === CARLOS ? w.punches : w.viewerId === MADISON ? madisonPunches : [],
    open: w.clockedInAt && w.viewerId === CARLOS ? { clocked_in_at: w.clockedInAt, on_break: false, needs_manual_close: false } : null,
    todayISO: today, week, period: payPeriodContaining(today),
  });
}

function tradeable(i: DemoInstance): TradeableInstance {
  return { id: i.id, user_id: 'owner', employee_id: i.employee_id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, status: i.status, released_at: null, role: i.role, offer_state: i.offer_state };
}

export function tradeOptionsFor(w: DemoWorld, instanceId: string): TradeOptionsPayload {
  const meId = w.viewerId; const me = empOf(w, meId);
  const mine = w.instances.find((i) => i.id === instanceId);
  if (!mine || mine.employee_id !== meId) throw new Error(TRADE_REFUSAL_MESSAGES.NOT_YOUR_SHIFT);
  const active = new Set(w.trades.filter((t) => LIVE.has(t.status)).flatMap((t) => [t.requester_shift_instance_id, t.target_shift_instance_id]));
  const opts = buildTradeOptions({
    mine: tradeable(mine), me: { id: meId, role: me.role, status: 'active' },
    myDates: new Set(w.instances.filter((i) => i.employee_id === meId && i.status !== 'released' && i.shift_date >= today).map((i) => i.shift_date)),
    candidates: w.employees.filter((e) => e.id !== meId && e.role === me.role).map((e) => ({ employee: { ...e, status: 'active' }, instances: w.instances.filter((i) => i.employee_id === e.id && i.status !== 'released' && i.shift_date >= today).map(tradeable) })),
    activeTradeInstanceIds: active, nowMs: Date.now(),
  });
  return {
    my_shift: { instance_id: mine.id, shift_date: mine.shift_date, starts_at: mine.starts_at, ends_at: mine.ends_at, hours: instanceHours(mine.starts_at, mine.ends_at) },
    coworkers: opts.map((o) => ({ employee_id: o.employee_id, name: o.name, role: o.role, shifts: o.shifts.map((s) => ({ ...s, hours: instanceHours(s.starts_at, s.ends_at) })) })),
  };
}

// ── the state machine (mirrors the server rules; the preview's "database") ───────────────────

const nowISO = () => new Date().toISOString();
let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

export type Mutation = (w: DemoWorld) => DemoWorld;

export const act = {
  offer: (id: string): Mutation => (w) => {
    const i = w.instances.find((x) => x.id === id);
    if (!i || i.employee_id !== w.viewerId) throw new Error('That shift is not yours to drop.');
    if (w.trades.some((t) => LIVE.has(t.status) && (t.requester_shift_instance_id === id || t.target_shift_instance_id === id))) throw new Error('This shift is part of a pending trade. Cancel the trade before offering it.');
    return { ...w, instances: w.instances.map((x) => (x.id === id ? { ...x, offer_state: 'offered', offer_id: nid('offer') } : x)), log: [`${nameOf(w, w.viewerId)} offered ${i.shift_date} — still theirs until a manager approves someone`, ...w.log] };
  },
  cancelOffer: (id: string): Mutation => (w) => ({
    ...w,
    instances: w.instances.map((x) => (x.id === id ? { ...x, offer_state: 'closed' } : x)),
    pickups: w.pickups.map((p) => (p.shift_instance_id === id && p.status === 'pending' ? { ...p, status: 'superseded', decided_at: nowISO() } : p)),
    log: ['Offer cancelled — pending pickup requests superseded', ...w.log],
  }),
  pickup: (id: string): Mutation => (w) => {
    const i = w.instances.find((x) => x.id === id);
    if (!i || i.offer_state !== 'offered') throw new Error('This shift is no longer available.');
    if (w.pickups.some((p) => p.shift_instance_id === id && p.claimed_by === w.viewerId && p.status === 'pending')) throw new Error('Pickup requested');
    return { ...w, pickups: [...w.pickups, { claim_id: nid('pk'), shift_instance_id: id, claimed_by: w.viewerId, offer_id: i.offer_id, status: 'pending', requested_at: nowISO(), decided_at: null }], log: [`${nameOf(w, w.viewerId)} requested to pick up ${nameOf(w, i.employee_id)}'s ${i.shift_date} — pending manager`, ...w.log] };
  },
  requestTrade: (mineId: string, theirsId: string): Mutation => (w) => {
    const mine = w.instances.find((x) => x.id === mineId)!; const theirs = w.instances.find((x) => x.id === theirsId)!;
    const me = empOf(w, w.viewerId); const them = empOf(w, theirs.employee_id);
    const active = new Set(w.trades.filter((t) => LIVE.has(t.status)).flatMap((t) => [t.requester_shift_instance_id, t.target_shift_instance_id]));
    const plan = planTradeRequest({
      mine: tradeable(mine), theirs: tradeable(theirs), me: { id: me.id, role: me.role, status: 'active' }, them: { id: them.id, role: them.role, status: 'active' },
      myOtherDates: otherDates(w.instances.filter((i) => i.employee_id === me.id).map((i) => i.shift_date), mine.shift_date),
      theirOtherDates: otherDates(w.instances.filter((i) => i.employee_id === them.id).map((i) => i.shift_date), theirs.shift_date),
      activeTradeInstanceIds: active, nowMs: Date.now(),
    });
    if (!plan.ok) throw new Error(TRADE_REFUSAL_MESSAGES[plan.code]);
    return { ...w, trades: [{ id: nid('tr'), requester_employee_id: me.id, requester_shift_instance_id: mineId, target_employee_id: them.id, target_shift_instance_id: theirsId, status: 'pending_coworker', coworker_response: null, coworker_responded_at: null, decided_at: null, decision_note: null, cancelled_at: null, created_at: nowISO() }, ...w.trades], log: [`${me.name} proposed a trade to ${them.name} — waiting for ${them.name.split(' ')[0]}`, ...w.log] };
  },
  respondTrade: (id: string, r: 'accept' | 'decline'): Mutation => (w) => {
    const t = w.trades.find((x) => x.id === id);
    if (!t || t.target_employee_id !== w.viewerId || t.status !== 'pending_coworker') throw new Error('This trade is no longer waiting for your answer.');
    return { ...w, trades: w.trades.map((x) => (x.id === id ? { ...x, status: r === 'accept' ? 'pending_manager' : 'declined', coworker_response: r === 'accept' ? 'accepted' : 'declined', coworker_responded_at: nowISO() } : x)), log: [`${nameOf(w, w.viewerId)} ${r === 'accept' ? 'accepted' : 'declined'} the trade${r === 'accept' ? ' — now waiting for a manager' : ''}`, ...w.log] };
  },
  cancelTrade: (id: string): Mutation => (w) => ({ ...w, trades: w.trades.map((x) => (x.id === id && LIVE.has(x.status) ? { ...x, status: 'cancelled', cancelled_at: nowISO() } : x)), log: ['Trade request cancelled', ...w.log] }),
  requestTimeOff: (start: string, end: string, reason: string): Mutation => (w) => ({ ...w, timeOff: [...w.timeOff, { id: nid('to'), employee_id: w.viewerId, start_date: start, end_date: end, reason: reason || null, status: 'pending', decision_note: null, created_at: nowISO(), decided_at: null }], log: [`Time off requested ${start} – ${end}`, ...w.log] }),
  withdrawTimeOff: (id: string): Mutation => (w) => ({ ...w, timeOff: w.timeOff.filter((r) => r.id !== id), log: ['Time-off request withdrawn', ...w.log] }),

  // manager side
  decidePickup: (claimId: string, action: 'approve' | 'decline'): Mutation => (w) => {
    const p = w.pickups.find((x) => x.claim_id === claimId); if (!p) return w;
    if (action === 'decline') return { ...w, pickups: w.pickups.map((x) => (x.claim_id === claimId ? { ...x, status: 'rejected', decided_at: nowISO() } : x)), log: ['Manager declined a pickup — the shift stays offered', ...w.log] };
    const i = w.instances.find((x) => x.id === p.shift_instance_id)!;
    return {
      ...w,
      instances: w.instances.map((x) => (x.id === i.id ? { ...x, employee_id: p.claimed_by, status: 'claimed', offer_state: 'transferred' } : x)),
      pickups: w.pickups.map((x) => (x.claim_id === claimId ? { ...x, status: 'approved', decided_at: nowISO() } : x.shift_instance_id === i.id && x.status === 'pending' ? { ...x, status: 'superseded', decided_at: nowISO() } : x)),
      log: [`Manager approved: ${i.shift_date} moved from ${nameOf(w, i.employee_id)} to ${nameOf(w, p.claimed_by)}`, ...w.log],
    };
  },
  decideTrade: (id: string, action: 'approve' | 'decline'): Mutation => (w) => {
    const t = w.trades.find((x) => x.id === id); if (!t || t.status !== 'pending_manager') return w;
    if (action === 'decline') return { ...w, trades: w.trades.map((x) => (x.id === id ? { ...x, status: 'declined', decided_at: nowISO() } : x)), log: ['Manager declined the trade — both shifts stay put', ...w.log] };
    return {
      ...w,
      instances: w.instances.map((x) => x.id === t.requester_shift_instance_id ? { ...x, employee_id: t.target_employee_id, status: 'claimed' } : x.id === t.target_shift_instance_id ? { ...x, employee_id: t.requester_employee_id, status: 'claimed' } : x),
      trades: w.trades.map((x) => (x.id === id ? { ...x, status: 'approved', decided_at: nowISO() } : x)),
      log: [`Manager approved the trade — ${nameOf(w, t.requester_employee_id)} and ${nameOf(w, t.target_employee_id)} swapped`, ...w.log],
    };
  },
  /**
   * Confirm / unconfirm a punch, carrying the approved minutes — mirroring
   * lensed_confirm_time_clock_shift, INCLUDING its refusal to confirm a live host without a
   * figure, so the preview shows the same error the server would raise.
   */
  confirmPunch: (id: string, confirmed: boolean, approvedMinutes: number | null): Mutation => (w) => {
    const c = w.confirmable.find((x) => x.id === id);
    if (!c) return w;
    if (confirmed && empOf(w, c.employee_id).role === 'host' && approvedMinutes == null && c.approved_minutes == null) {
      throw new Error('HOST_APPROVED_MINUTES_REQUIRED');
    }
    return {
      ...w,
      confirmable: w.confirmable.map((x) => (x.id === id
        ? confirmed
          ? { ...x, confirmed_at: x.confirmed_at ?? nowISO(), approved_minutes: approvedMinutes ?? x.approved_minutes }
          : { ...x, confirmed_at: null, approved_minutes: null }
        : x)),
      log: [confirmed
        ? `Manager confirmed ${nameOf(w, c.employee_id)} — approved ${approvedMinutes ?? c.approved_minutes} min (punch untouched)`
        : `Manager unconfirmed ${nameOf(w, c.employee_id)} — approval withdrawn`, ...w.log],
    };
  },
  decideTimeOff: (id: string, status: 'approved' | 'denied'): Mutation => (w) => ({ ...w, timeOff: w.timeOff.map((r) => (r.id === id ? { ...r, status, decided_at: nowISO() } : r)), log: [`Manager ${status} time off`, ...w.log] }),
  setViewer: (id: string): Mutation => (w) => ({ ...w, viewerId: id }),
  toggleClockedIn: (): Mutation => (w) => ({ ...w, clockedInAt: w.clockedInAt ? null : at(today, 17, 58) }),
  reset: (): Mutation => () => initialWorld(),
};

/**
 * The manager's confirmation tiles, built with the REAL buildCalendarDays so PersonCard receives
 * exactly the DayPerson shape production gives it (including clockedHours and approvedMinutes).
 */
export function confirmationTiles(w: DemoWorld): { key: string; person: DayPerson; dateLabel: string }[] {
  const out: { key: string; person: DayPerson; dateLabel: string }[] = [];
  for (const c of w.confirmable) {
    const emp = empOf(w, c.employee_id);
    const days = buildCalendarDays({
      employees: [{ id: emp.id, name: emp.name, role: emp.role }],
      punches: [{
        id: c.id, employee_id: c.employee_id, source: 'time_clock', date: c.date,
        start_time: c.start_time, end_time: c.end_time,
        clock_in_at: c.clock_in_at, clock_out_at: c.clock_out_at,
        break_minutes: c.break_minutes, confirmed_at: c.confirmed_at,
        approved_minutes: c.approved_minutes, auto_closed: false,
      }],
      scheduled: [], days: [c.date], view: 'clocked', todayISO: today,
    });
    const person = days.get(c.date)?.people[0];
    if (person) out.push({ key: c.id, person, dateLabel: c.date });
  }
  return out;
}

/** Planned shifts in the requested range for the manager's time-off conflict count. */
export function timeOffConflicts(w: DemoWorld, r: DemoTimeOff): number {
  return w.instances.filter((i) => i.employee_id === r.employee_id && i.status !== 'released' && i.shift_date >= r.start_date && i.shift_date <= r.end_date).length;
}

export { nameOf };
