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
 * HOW THE TWO RELATE — both are first-class, neither is a substitute
 *   $/SKU = $/box ÷ SKUs per box
 * $/box tracks the work the crew controls; $/SKU tracks what it costs to move a unit, which
 * also moves with the TikTok combine settings. Between mid-August and 2026-09-02, boxes per
 * paid hour stayed flat (14.9 → 14.3) while SKUs per paid hour rose 15% (44.1 → 50.6), purely
 * because orders-per-box went 2.95 → 3.54. So a change in $/SKU can come from bundling, from
 * crew speed, or from both, and the two figures have to be read together to tell which.
 * Neither is presented as the "real" one — accuracy of both is the requirement, which is what
 * the payable/pending/live split, the true unit count, and the DataQuality flags are all for.
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
  live_hours: number;      // STILL CLOCKED IN — elapsed so far, minus breaks taken. No shifts
  live_cents: number;      // row exists yet, so without this the day reads "—" until clock-out.
  suspect_hours: number;   // unconfirmed punches over MAX_PLAUSIBLE_PUNCH_HOURS — a forgotten
  suspect_punches: number; // clock-out. Held OUT of the projection, reported so it is visible.
}

/**
 * An in-progress punch, straight off `employee_time_entries` with `clocked_out_at IS NULL`.
 *
 * WHY THIS EXISTS: a `shifts` row is not written until CLOCK-OUT (verified — the one currently
 * open time entry has `shift_id = null`). So for the whole working day there are no hours to
 * divide by, and both \$/box and \$/SKU render "—" until the crew punches out. The figures only
 * appeared in testing because the day crew had already left at 14:01.
 *
 * `break_minutes_so_far` covers breaks CLOSED during this punch plus any break still running,
 * so a picker sitting on lunch does not accrue paid minutes.
 */
export interface OpenPunch {
  employee_id: string;
  clocked_in_at: string;
  break_minutes_so_far?: number;
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
  openPunches: ReadonlyArray<OpenPunch> = [],
  nowMs: number = Date.now(),
): Map<string, EmployeeDayCost> {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const out = new Map<string, EmployeeDayCost>();

  const bucket = (id: string): EmployeeDayCost => {
    let b = out.get(id);
    if (!b) {
      b = {
        employee_id: id, payable_hours: 0, payable_cents: 0,
        pending_hours: 0, pending_cents: 0, live_hours: 0, live_cents: 0,
        suspect_hours: 0, suspect_punches: 0,
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

  // ── IN-PROGRESS punches: hours worked so far, for the day currently running ──
  // Bucketed through the SAME zonedDayKey boundary as everything else, so a night-crew punch
  // that started at 17:00 counts on that shift day rather than the next one.
  for (const p of openPunches) {
    const emp = byId.get(p.employee_id);
    if (!emp) continue;
    if ((emp.role ?? '').trim().toLowerCase() !== 'fulfillment') continue;
    const startMs = Date.parse(p.clocked_in_at);
    if (!Number.isFinite(startMs)) continue;
    if (zonedDayKey(startMs, tz) !== dayISO) continue;

    const elapsedH = (nowMs - startMs) / 3_600_000;
    const hours = elapsedH - (p.break_minutes_so_far ?? 0) / 60;
    if (!(hours > 0)) continue; // clock skew, or entirely on break

    const rate = Number(emp.hourly_rate) || 0;
    const b = bucket(emp.id);
    if (hours > MAX_PLAUSIBLE_PUNCH_HOURS) {
      // Already open longer than any real shift — somebody never clocked out. Same treatment
      // as a closed runaway punch: reported, never projected.
      b.suspect_hours += hours;
      b.suspect_punches += 1;
    } else {
      b.live_hours += hours;
      b.live_cents += Math.round(hours * rate * 100);
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
  live_hours: number;       // still on the clock right now
  live_cents: number;
  suspect_hours: number;    // forgotten clock-outs, excluded from every figure below
  suspect_punches: number;
  cost_per_box_cents: number | null;
  cost_per_order_cents: number | null;
  cost_per_box_cents_projected: number | null;
  cost_per_order_cents_projected: number | null;
}

// `orders` here is the SKU/unit count — the true denominator for $/SKU (see PickerCostRow).
function costBlock(c: EmployeeDayCost, boxes: number, orders: number): CostBlock {
  // The projection spans everything that will become payable: confirmed hours, hours awaiting
  // confirmation, and hours still being worked. Suspect hours are deliberately absent.
  const totalCents = c.payable_cents + c.pending_cents + c.live_cents;
  return {
    payable_hours: c.payable_hours,
    payable_cents: c.payable_cents,
    pending_hours: c.pending_hours,
    pending_cents: c.pending_cents,
    live_hours: c.live_hours,
    live_cents: c.live_cents,
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
  pending_hours: 0, pending_cents: 0, live_hours: 0, live_cents: 0,
  suspect_hours: 0, suspect_punches: 0,
};

// The day's TOTAL completed work, attributed or not — the correct crew denominator.
export interface DayTotals {
  boxes_completed: number;
  orders_picked: number;
}

// A box as this module needs it, straight off shipment_verifications. Raw boxes (not just the
// aggregated PickerDayStats) are required for two accuracy jobs the aggregate cannot do:
// counting true UNITS, and checking each completion against the picker's punch window.
export interface CostBox {
  picker_employee_id: string | null;
  picker_name_snapshot: string | null;
  order_ids: string[];
  verified_at: string;
}

// A punch window to test a completion against. `end: null` = still clocked in.
export interface PunchWindow {
  employee_id: string;
  start: string;
  end: string | null;
}

/**
 * The picker-grouping key.
 *
 * MIRRORS aggregateFulfillmentDay's grouping EXACTLY — employee id when present, else the name
 * snapshot (which survives rename and deletion), else nothing. Kept as one exported function
 * so the mirroring is testable rather than a coincidence; pickCostEconomics.test.mjs asserts
 * all three cases against the aggregate's own output.
 */
export function pickerKey(b: { picker_employee_id: string | null; picker_name_snapshot: string | null }): string | null {
  const id = b.picker_employee_id ?? null;
  if (id) return `id:${id}`;
  const snap = (b.picker_name_snapshot ?? '').trim() || null;
  return snap ? `name:${snap}` : null;
}

// Same key, derived from an already-aggregated row.
function rowKey(r: PickerDayStats): string | null {
  return pickerKey({ picker_employee_id: r.picker_employee_id, picker_name_snapshot: r.name });
}

/**
 * True SKU (unit) count for a set of boxes.
 *
 * $/SKU divides by UNITS, so counting `order_ids.length` is only right while every order holds
 * exactly one unit. Over 2026-08-18..09-02 that held perfectly — 48,809 order refs in verified
 * boxes summed to exactly 48,809 units — but 139 of 148,647 orders since July carry units > 1,
 * so the moment one lands in a box the array length undercounts and $/SKU reads high. An order
 * missing from the map counts as 1: the fallback matches the overwhelmingly common case and
 * never silently zeroes a box.
 */
export function skuCount(orderIds: ReadonlyArray<string>, unitsByOrderId?: ReadonlyMap<string, number>): number {
  const seen = new Set(orderIds);
  if (!unitsByOrderId) return seen.size;
  let units = 0;
  for (const id of seen) units += unitsByOrderId.get(id) ?? 1;
  return units;
}

/**
 * How many completions fall OUTSIDE every punch window of the picker credited with them.
 *
 * A box completed with no matching punch means the boxes are counted but the hours behind them
 * are not, so $/box reads too cheap. This is punch discipline, not a code bug — it cannot be
 * corrected here, only surfaced. Recent days are clean (0.0-0.2% since 08-26) but it spikes:
 * 26.8% on 08-18, 14.9% on 08-29, 8.1% on 08-25.
 *
 * A box with no attributable picker is not counted as outside — there is no punch to compare to.
 */
export function countBoxesOutsidePunch(
  boxes: ReadonlyArray<CostBox>,
  windows: ReadonlyArray<PunchWindow>,
  nowMs: number = Date.now(),
): { examined: number; outside: number } {
  const byEmployee = new Map<string, { s: number; e: number }[]>();
  for (const w of windows) {
    const s = Date.parse(w.start);
    if (!Number.isFinite(s)) continue;
    const e = w.end == null ? nowMs : Date.parse(w.end);
    if (!Number.isFinite(e)) continue;
    const list = byEmployee.get(w.employee_id) ?? [];
    list.push({ s, e });
    byEmployee.set(w.employee_id, list);
  }

  let examined = 0;
  let outside = 0;
  for (const b of boxes) {
    if (!b.picker_employee_id) continue; // nothing to compare against
    const t = Date.parse(b.verified_at);
    if (!Number.isFinite(t)) continue;
    examined += 1;
    const list = byEmployee.get(b.picker_employee_id) ?? [];
    if (!list.some((w) => t >= w.s && t <= w.e)) outside += 1;
  }
  return { examined, outside };
}

// What the day's inputs are worth trusting. Reported so a figure built on bad data is labelled
// rather than either hidden or presented as clean.
export interface DataQuality {
  boxes_examined: number;         // attributable boxes checked against a punch
  boxes_outside_punch: number;    // …of those, completed with no matching punch
  shifts_examined: number;        // fulfillment shifts on the day
  shifts_with_break: number;      // …of those, with any unpaid break recorded
}

// A picker row plus its track, its true SKU count, and its cost. Extends the existing,
// unit-tested PickerDayStats rather than replacing it, so every KPI already on the view keeps
// its exact meaning — `orders_picked` stays ORDERS; `skus_picked` is the unit count.
export interface PickerCostRow extends PickerDayStats {
  fulfillment_track: FulfillmentTrack | null;
  on_clock: boolean;    // had a fulfillment punch on this day (payable, pending or live)
  skus_picked: number;  // TRUE units — the $/SKU denominator
  cost: CostBlock;
}

export interface FulfillmentEconomics {
  rows: PickerCostRow[];
  cost: CostBlock;              // crew-wide, over ALL fulfillment hours on the clock that day
  skus_picked: number;          // crew-wide true unit count
  unproductive_hours: number;   // hours by on-clock fulfillment staff who completed ZERO boxes
  unproductive_cents: number;   // …and what those hours cost. Explains the crew $/box.
  suspect_hours: number;        // punches past MAX_PLAUSIBLE_PUNCH_HOURS…
  suspect_punches: number;      // …excluded from the projection, surfaced so they get fixed.
  quality: DataQuality;
}

export interface EconomicsInput {
  pickers: ReadonlyArray<PickerDayStats>;
  costByEmployee: ReadonlyMap<string, EmployeeDayCost>;
  nameById?: Record<string, string>;
  trackById?: Record<string, FulfillmentTrack | null>;
  /** Raw boxes — needed for true SKU counts and the off-clock check. */
  boxes?: ReadonlyArray<CostBox>;
  unitsByOrderId?: ReadonlyMap<string, number>;
  punchWindows?: ReadonlyArray<PunchWindow>;
  /** The day's TOTAL completed work incl. unassigned — the crew denominator. */
  dayTotals?: DayTotals;
  breakStats?: { shifts: number; withBreak: number };
  nowMs?: number;
}

/**
 * Merge cost, track and true SKU counts onto the day's picker rows, and add rows for people who
 * were ON THE CLOCK but completed no boxes.
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
export function buildFulfillmentEconomics(input: EconomicsInput): FulfillmentEconomics {
  const {
    pickers, costByEmployee, nameById = {}, trackById = {},
    boxes, unitsByOrderId, punchWindows, dayTotals, breakStats,
    nowMs = Date.now(),
  } = input;

  // True unit counts per picker, using the SAME grouping rule as the aggregate.
  const skusByKey = new Map<string, number>();
  let skuTotal = 0;
  for (const b of boxes ?? []) {
    const n = skuCount(b.order_ids ?? [], unitsByOrderId);
    skuTotal += n;
    const k = pickerKey(b);
    if (k) skusByKey.set(k, (skusByKey.get(k) ?? 0) + n);
  }
  const hasBoxes = (boxes?.length ?? 0) > 0;

  const rows: PickerCostRow[] = pickers.map((p) => {
    const c = (p.picker_employee_id && costByEmployee.get(p.picker_employee_id)) || ZERO_COST;
    const k = rowKey(p);
    // Fall back to the order count when raw boxes were not supplied.
    const skus = hasBoxes && k != null ? (skusByKey.get(k) ?? 0) : p.orders_picked;
    return {
      ...p,
      fulfillment_track: (p.picker_employee_id && trackById[p.picker_employee_id]) || null,
      on_clock: c.payable_hours > 0 || c.pending_hours > 0 || c.live_hours > 0,
      skus_picked: skus,
      cost: costBlock(c, p.boxes_completed, skus),
    };
  });

  // On the clock, zero boxes → no row exists yet. Add one so the hours are visible.
  const seen = new Set(pickers.map((p) => p.picker_employee_id).filter((id): id is string => !!id));
  for (const [id, c] of costByEmployee) {
    if (seen.has(id)) continue;
    if (c.payable_hours <= 0 && c.pending_hours <= 0 && c.live_hours <= 0) continue;
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
      skus_picked: 0,
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
    crew.live_hours += c.live_hours;
    crew.live_cents += c.live_cents;
    crew.suspect_hours += c.suspect_hours;
    crew.suspect_punches += c.suspect_punches;
  }

  // The crew denominator is the day's TOTAL completed work, not the sum of the attributed
  // rows. Unassigned boxes (no picker id and no name snapshot) were still picked by somebody
  // who was on the clock, so charging every paid hour against only the attributed boxes
  // overstates the crew rate. On 2026-08-31 that was 26 unassigned boxes out of 1,159 — the
  // difference between $1.53/box (correct) and $1.57/box.
  const crewBoxes = dayTotals?.boxes_completed ?? rows.reduce((s, r) => s + r.boxes_completed, 0);
  const crewSkus = hasBoxes ? skuTotal : (dayTotals?.orders_picked ?? rows.reduce((s, r) => s + r.skus_picked, 0));

  let unproductiveHours = 0;
  let unproductiveCents = 0;
  for (const r of rows) {
    if (r.boxes_completed > 0) continue;
    unproductiveHours += r.cost.payable_hours + r.cost.pending_hours + r.cost.live_hours;
    unproductiveCents += r.cost.payable_cents + r.cost.pending_cents + r.cost.live_cents;
  }

  const off = boxes && punchWindows
    ? countBoxesOutsidePunch(boxes, punchWindows, nowMs)
    : { examined: 0, outside: 0 };

  return {
    rows,
    cost: costBlock(crew, crewBoxes, crewSkus),
    skus_picked: crewSkus,
    unproductive_hours: unproductiveHours,
    unproductive_cents: unproductiveCents,
    suspect_hours: crew.suspect_hours,
    suspect_punches: crew.suspect_punches,
    quality: {
      boxes_examined: off.examined,
      boxes_outside_punch: off.outside,
      shifts_examined: breakStats?.shifts ?? 0,
      shifts_with_break: breakStats?.withBreak ?? 0,
    },
  };
}

// One track's roll-up. `track: null` is the "Unset" bucket — shown rather than hidden, because
// an unset track is the reason a cost comparison across tracks is incomplete.
export interface TrackSubtotal {
  track: FulfillmentTrack | null;
  people: number;
  boxes_completed: number;
  orders_picked: number; // TRUE unit (SKU) count for the bucket
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
      agg.live_hours += r.cost.live_hours;
      agg.live_cents += r.cost.live_cents;
      agg.suspect_hours += r.cost.suspect_hours;
      agg.suspect_punches += r.cost.suspect_punches;
      boxes += r.boxes_completed;
      orders += r.skus_picked; // TRUE units — matches the $/SKU denominator on the rows
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
