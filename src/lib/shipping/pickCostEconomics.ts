/**
 * Fulfillment unit economics — cost per box and cost per SKU for one fulfillment day.
 *
 * WHAT A "BOX" AND A "SKU" ARE HERE
 *   box  = one label = one physical package a picker completes (a shipment_verifications row)
 *   SKU  = one order inside that box = one auction won = one unit picked
 * Measured on 2026-09-02: synced_order_ids.units is 1 for essentially every order, so the
 * order count inside a box IS the unit/SKU count. `orders_picked` and "SKUs picked" are the
 * same number, and the field keeps the name the rest of the pipeline uses.
 *
 * WHY BOTH, AND WHY $/BOX IS THE HONEST ONE
 * Picking cost is fundamentally PER BOX — one label, one walk, one pack. $/SKU only falls
 * because bundling amortizes that fixed cost over more units: between mid-August and
 * 2026-09-02, boxes/paid-hour stayed flat (14.9 → 14.3) while SKUs/paid-hour rose 15%
 * (44.1 → 50.6) purely because orders-per-box went 2.95 → 3.54. So $/SKU will keep drifting
 * down as combine settings deepen and will make a flat crew look like it is improving.
 * Both are surfaced; $/box is the one to judge people on.
 *
 * PURITY / TESTING
 * All math here is pure. The two value-imports are reused VERBATIM and never reimplemented:
 *   • isPayableShift / paidShiftHours / isOpenShift — the payroll gate, so cost here can
 *     never drift from what PayView actually pays (same discipline as src/lib/labor.ts).
 *   • zonedDayKey — so hours and boxes are bucketed on the SAME 04:00 boundary.
 * pickCostEconomics.test.mjs rewires both imports to runtime-transpiled modules.
 */

import { isOpenShift, isPayableShift, paidShiftHours, type ShiftLike } from '@/lib/employees';
import { SHOP_TIMEZONE, zonedDayKey, type PickerDayStats } from '@/lib/shipping/pickerPerformance';

// The fulfillment sub-type. DISPLAY AND GROUPING ONLY — nothing gates on it (migration 121).
// A 'packer' remains a fully eligible picker everywhere, so a mis-set track can never lock
// somebody out of picking mid-shift.
export const FULFILLMENT_TRACKS = ['picker', 'packer', 'flex'] as const;
export type FulfillmentTrack = (typeof FULFILLMENT_TRACKS)[number];

export function isFulfillmentTrack(v: unknown): v is FulfillmentTrack {
  return typeof v === 'string' && (FULFILLMENT_TRACKS as readonly string[]).includes(v);
}

// The shift shape this module needs: payroll's fields PLUS `date` (the bucket fallback for a
// manual shift with no punch instants). Identical in spirit to labor.ts's LaborShift.
export type CostShift = ShiftLike & { date: string };

/**
 * Longest plausible SINGLE punch. Beyond this it is a forgotten clock-out, not a shift.
 *
 * Staff do not reliably clock out and `needs_manual_close` is set on zero rows: real single
 * punches of 81h, 56h, 55h, 48h and 47h exist in this table. Those never reach payroll —
 * isPayableShift holds back any unconfirmed time-clock shift, and every runaway punch is
 * unconfirmed — but they DO poison a projection built from pending hours. On 2026-08-31 the
 * pending pool was 70.1h, of which carlos's single 47.15h punch and Joseph's 23.81h were
 * essentially all of it: projecting them put the day at $2.93/box against $1.57 confirmed.
 *
 * 18h is chosen to clear a legitimate double shift (two 8h crews back to back, which really
 * happens — Alejandro worked 16.08h across TWO ~8h punches on 08-31) while catching every
 * observed anomaly, all of which are a single punch well past 20h. The threshold is per
 * PUNCH, never per day-sum, precisely so a genuine double is not mistaken for an anomaly.
 *
 * A suspect punch is excluded from the PROJECTION only. It is never removed from payable
 * hours: if a manager confirmed it, payroll is paying it, and a cost figure that quietly
 * disagreed with payroll would be worse than one that looks bad.
 */
export const MAX_PLAUSIBLE_PUNCH_HOURS = 18;

// The employee fields cost needs. hourly_rate ONLY — no name, no pay history.
export interface CostEmployee {
  id: string;
  role: string;
  hourly_rate: number;
  fulfillment_track?: FulfillmentTrack | null;
}

/**
 * The fulfillment day a shift's hours book to.
 *
 * Deliberately NOT labor.ts's pacificDate(): that buckets on the CALENDAR date, which would
 * put a 02:00 punch on a different day than the boxes that punch produced (boxes bucket on
 * the 04:00 SHIFT_DAY_START_HOUR boundary, so 02:00 belongs to the previous fulfillment day).
 * Bucketing hours through zonedDayKey makes the numerator and denominator of every rate here
 * share one boundary by construction.
 *
 * A shift with no clock_in_at (manual/hand-entered) has no instant to place, so it falls back
 * to shifts.date — the same fallback labor.ts uses.
 */
export function shiftFulfillmentDay(s: CostShift, tz: string = SHOP_TIMEZONE): string {
  return s.clock_in_at ? zonedDayKey(Date.parse(s.clock_in_at), tz) : s.date;
}

// One employee's hours and money for the day, split by whether payroll will actually pay it.
export interface EmployeeDayCost {
  employee_id: string;
  payable_hours: number;   // passes isPayableShift → PayView pays this today
  payable_cents: number;
  pending_hours: number;   // would be payable but for manager confirmation (suspect excluded)
  pending_cents: number;
  suspect_hours: number;   // unconfirmed punches over MAX_PLAUSIBLE_PUNCH_HOURS — a forgotten
  suspect_punches: number; // clock-out. Held OUT of the projection, reported so it is visible.
}

/**
 * Per-employee hours + cost for ONE fulfillment day, split payable vs pending-confirmation.
 *
 * The split exists because of a real trap: a time-clock punch is held back from pay until a
 * manager sets confirmed_at, and confirmation typically lands a day late. On 2026-09-02 all
 * five fulfillment punches were unconfirmed, so payable hours for the day in progress were
 * ZERO — a naive $/box would render "—" on exactly the day a manager is looking at, then
 * silently climb later as punches confirm. So payable is reported as the truth and pending is
 * reported alongside it as an explicitly-labelled projection. The payroll gate is never
 * weakened to make a number appear.
 *
 * Only role 'fulfillment' employees are considered — host punches are not picking labor.
 */
export function employeeCostForDay(
  employees: ReadonlyArray<CostEmployee>,
  shifts: ReadonlyArray<CostShift>,
  dayISO: string,
  tz: string = SHOP_TIMEZONE,
): Map<string, EmployeeDayCost> {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const out = new Map<string, EmployeeDayCost>();

  const bucket = (id: string): EmployeeDayCost => {
    let b = out.get(id);
    if (!b) {
      b = {
        employee_id: id, payable_hours: 0, payable_cents: 0,
        pending_hours: 0, pending_cents: 0, suspect_hours: 0, suspect_punches: 0,
      };
      out.set(id, b);
    }
    return b;
  };

  for (const s of shifts) {
    const emp = byId.get(s.employee_id);
    if (!emp) continue;                                        // orphan punch — skip defensively
    if ((emp.role ?? '').trim().toLowerCase() !== 'fulfillment') continue; // hosts aren't pick labor
    if (shiftFulfillmentDay(s, tz) !== dayISO) continue;

    const rate = Number(emp.hourly_rate) || 0;

    if (isPayableShift(s)) {
      const hours = paidShiftHours(s);
      const b = bucket(emp.id);
      b.payable_hours += hours;
      b.payable_cents += Math.round(hours * rate * 100);
      continue;
    }

    // Pending = completed, not a materialized plan row, time-clock, awaiting confirmation.
    // Anything else (an OPEN punch with indeterminate hours, a source_rule_id plan row) is
    // neither payable nor pending and contributes nothing.
    if (!isOpenShift(s) && s.source_rule_id == null && s.source === 'time_clock' && s.confirmed_at == null) {
      const hours = paidShiftHours(s);
      const b = bucket(emp.id);
      if (hours > MAX_PLAUSIBLE_PUNCH_HOURS) {
        // Forgotten clock-out. Kept out of the projection so one unclosed punch cannot
        // double the day's apparent cost, but counted so it can be shown and fixed.
        b.suspect_hours += hours;
        b.suspect_punches += 1;
      } else {
        b.pending_hours += hours;
        b.pending_cents += Math.round(hours * rate * 100);
      }
    }
  }

  return out;
}

// Integer cents per unit, or null when the rate is not computable (no money, or no units).
// Returning null rather than 0 keeps "nobody was on the clock" visually distinct from "free".
export function perUnitCents(cents: number, units: number): number | null {
  if (!Number.isFinite(cents) || cents <= 0) return null;
  if (!Number.isFinite(units) || units <= 0) return null;
  return cents / units;
}

// Cost block attached to a picker row and to the day summary. `*_projected` includes
// pending-confirmation hours; when nothing is pending it equals the confirmed figure.
export interface CostBlock {
  payable_hours: number;
  payable_cents: number;
  pending_hours: number;
  pending_cents: number;
  suspect_hours: number;    // forgotten clock-outs, excluded from every figure below
  suspect_punches: number;
  cost_per_box_cents: number | null;
  cost_per_order_cents: number | null;
  cost_per_box_cents_projected: number | null;
  cost_per_order_cents_projected: number | null;
}

function costBlock(c: EmployeeDayCost, boxes: number, orders: number): CostBlock {
  const totalCents = c.payable_cents + c.pending_cents;
  return {
    payable_hours: c.payable_hours,
    payable_cents: c.payable_cents,
    pending_hours: c.pending_hours,
    pending_cents: c.pending_cents,
    suspect_hours: c.suspect_hours,
    suspect_punches: c.suspect_punches,
    cost_per_box_cents: perUnitCents(c.payable_cents, boxes),
    cost_per_order_cents: perUnitCents(c.payable_cents, orders),
    cost_per_box_cents_projected: perUnitCents(totalCents, boxes),
    cost_per_order_cents_projected: perUnitCents(totalCents, orders),
  };
}

const ZERO_COST: EmployeeDayCost = {
  employee_id: '', payable_hours: 0, payable_cents: 0,
  pending_hours: 0, pending_cents: 0, suspect_hours: 0, suspect_punches: 0,
};

// The day's TOTAL completed work, attributed or not — the correct crew denominator.
export interface DayTotals {
  boxes_completed: number;
  orders_picked: number;
}

// A picker row plus its track and its cost. Extends the existing, unit-tested PickerDayStats
// rather than replacing it, so every KPI already on the view keeps its exact meaning.
export interface PickerCostRow extends PickerDayStats {
  fulfillment_track: FulfillmentTrack | null;
  on_clock: boolean;  // had a fulfillment punch on this day (payable or pending)
  cost: CostBlock;
}

export interface FulfillmentEconomics {
  rows: PickerCostRow[];
  cost: CostBlock;              // crew-wide, over ALL fulfillment hours on the clock that day
  unproductive_hours: number;   // hours by on-clock fulfillment staff who completed ZERO boxes
  unproductive_cents: number;   // …and what those hours cost. Explains the crew $/box.
  suspect_hours: number;        // unconfirmed punches past MAX_PLAUSIBLE_PUNCH_HOURS…
  suspect_punches: number;      // …excluded from the projection, surfaced so they get fixed.
}

/**
 * Merge cost + track onto the day's picker rows, and add rows for people who were ON THE CLOCK
 * but completed no boxes.
 *
 * That last part is the point. aggregateFulfillmentDay() only ever emits pickers that produced
 * a verification row, so somebody who clocked a full shift and completed nothing is invisible
 * — which is precisely the case that matters. On 2026-09-02 two of five fulfillment staff on
 * the clock (Joseph 7.80h, carlos 6.72h, ~$319) completed zero boxes, and nothing in the view
 * showed it. Their hours are ALSO what drags the crew figure (crew ran 14.3 boxes/paid hour
 * while the three who picked ran 23.6), so `unproductive_*` is reported to explain the crew
 * number rather than leaving it looking like everyone underperformed.
 *
 * Note what a zero-box row does NOT mean: packing, receiving, restocking, cleanup and training
 * write no rows anywhere, so they read as zero too. The row is a question to ask, not a verdict
 * — which is also why 'packer' and 'flex' exist as tracks.
 */
export function buildFulfillmentEconomics(
  pickers: ReadonlyArray<PickerDayStats>,
  costByEmployee: ReadonlyMap<string, EmployeeDayCost>,
  nameById: Record<string, string> = {},
  trackById: Record<string, FulfillmentTrack | null> = {},
  dayTotals?: DayTotals,
): FulfillmentEconomics {
  const rows: PickerCostRow[] = pickers.map((p) => {
    const c = (p.picker_employee_id && costByEmployee.get(p.picker_employee_id)) || ZERO_COST;
    return {
      ...p,
      fulfillment_track: (p.picker_employee_id && trackById[p.picker_employee_id]) || null,
      on_clock: c.payable_hours > 0 || c.pending_hours > 0,
      cost: costBlock(c, p.boxes_completed, p.orders_picked),
    };
  });

  // On the clock, zero boxes → no row exists yet. Add one so the hours are visible.
  const seen = new Set(pickers.map((p) => p.picker_employee_id).filter((id): id is string => !!id));
  for (const [id, c] of costByEmployee) {
    if (seen.has(id)) continue;
    if (c.payable_hours <= 0 && c.pending_hours <= 0) continue;
    rows.push({
      picker_employee_id: id,
      name: nameById[id] || 'Unknown employee',
      is_unassigned: false,
      orders_picked: 0,
      boxes_completed: 0,
      avg_pick_ms: null,
      active_pick_ms: null,
      orders_per_active_hour: null,
      valid_duration_count: 0,
      sessions: 0,
      median_gap_ms: null,
      fulfillment_track: trackById[id] ?? null,
      on_clock: true,
      cost: costBlock(c, 0, 0),
    });
  }

  // Busiest first, then anyone on the clock with no boxes, then the rest — stable by name.
  rows.sort((a, b) =>
    b.boxes_completed - a.boxes_completed
    || b.orders_picked - a.orders_picked
    || a.name.localeCompare(b.name));

  // Crew cost spans EVERY fulfillment hour on the clock, including hours that produced no
  // boxes. Summing only the pickers' own hours would quietly flatter the crew $/box.
  const crew: EmployeeDayCost = { ...ZERO_COST };
  for (const c of costByEmployee.values()) {
    crew.payable_hours += c.payable_hours;
    crew.payable_cents += c.payable_cents;
    crew.pending_hours += c.pending_hours;
    crew.pending_cents += c.pending_cents;
    crew.suspect_hours += c.suspect_hours;
    crew.suspect_punches += c.suspect_punches;
  }

  // The crew denominator is the day's TOTAL completed work, not the sum of the attributed
  // rows. Unassigned boxes (no picker id and no name snapshot) were still picked by somebody
  // who was on the clock, so charging every paid hour against only the attributed boxes
  // overstates the crew rate. On 2026-08-31 that was 26 unassigned boxes out of 1,159 — the
  // difference between $1.53/box (correct) and $1.57/box. `dayTotals` comes from
  // aggregateFulfillmentDay's summary, which counts attributed + unassigned.
  const crewBoxes = dayTotals?.boxes_completed ?? rows.reduce((s, r) => s + r.boxes_completed, 0);
  const crewOrders = dayTotals?.orders_picked ?? rows.reduce((s, r) => s + r.orders_picked, 0);

  let unproductiveHours = 0;
  let unproductiveCents = 0;
  for (const r of rows) {
    if (r.boxes_completed > 0) continue;
    unproductiveHours += r.cost.payable_hours + r.cost.pending_hours;
    unproductiveCents += r.cost.payable_cents + r.cost.pending_cents;
  }

  return {
    rows,
    cost: costBlock(crew, crewBoxes, crewOrders),
    unproductive_hours: unproductiveHours,
    unproductive_cents: unproductiveCents,
    suspect_hours: crew.suspect_hours,
    suspect_punches: crew.suspect_punches,
  };
}

// One track's roll-up. `track: null` is the "Unset" bucket — shown rather than hidden, because
// an unset track is the reason a cost comparison across tracks is incomplete.
export interface TrackSubtotal {
  track: FulfillmentTrack | null;
  people: number;
  boxes_completed: number;
  orders_picked: number;
  cost: CostBlock;
}

/**
 * Roll rows up by fulfillment track, so picker cost can be compared against packer cost.
 *
 * This is the whole reason the track exists: a packer who completes few boxes is not
 * underperforming, they are doing a job this table cannot see, and mixing them into one
 * crew average hides both facts. Buckets are returned in FULFILLMENT_TRACKS order with the
 * Unset bucket last, and only non-empty buckets are returned.
 */
export function subtotalByTrack(rows: ReadonlyArray<PickerCostRow>): TrackSubtotal[] {
  const order: (FulfillmentTrack | null)[] = [...FULFILLMENT_TRACKS, null];
  const out: TrackSubtotal[] = [];

  for (const track of order) {
    const group = rows.filter((r) => r.fulfillment_track === track);
    if (group.length === 0) continue;

    const agg: EmployeeDayCost = { ...ZERO_COST };
    let boxes = 0;
    let orders = 0;
    for (const r of group) {
      agg.payable_hours += r.cost.payable_hours;
      agg.payable_cents += r.cost.payable_cents;
      agg.pending_hours += r.cost.pending_hours;
      agg.pending_cents += r.cost.pending_cents;
      agg.suspect_hours += r.cost.suspect_hours;
      agg.suspect_punches += r.cost.suspect_punches;
      boxes += r.boxes_completed;
      orders += r.orders_picked;
    }

    out.push({
      track,
      people: group.length,
      boxes_completed: boxes,
      orders_picked: orders,
      cost: costBlock(agg, boxes, orders),
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting (pure; used by the UI)
// ─────────────────────────────────────────────────────────────────────────────

// Money per unit. Sub-dollar values carry three decimals because the whole range of interest
// is $0.20–$0.70 per SKU — two decimals collapse a 15% difference into the same string.
export function formatCentsPerUnit(cents: number | null): string {
  if (cents == null) return '—';
  const dollars = cents / 100;
  return dollars < 1 ? `$${dollars.toFixed(3)}` : `$${dollars.toFixed(2)}`;
}

// Whole-dollar money for hour costs and crew totals.
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Hours, one decimal. 0 renders as "0" rather than "0.0" to stay visually quiet.
export function formatHours(hours: number): string {
  if (hours <= 0) return '0';
  return hours.toFixed(1);
}

export function formatTrack(t: FulfillmentTrack | null): string {
  return t == null ? 'Unset' : t.charAt(0).toUpperCase() + t.slice(1);
}
