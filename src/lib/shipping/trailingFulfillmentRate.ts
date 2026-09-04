/**
 * Trailing fulfillment labor cost per unit SOLD — the rate the Shows tab allocates at.
 *
 * WHY THE DENOMINATOR IS UNITS SOLD, NOT UNITS PICKED
 * The first version of this divided by units picked (completed shipment_verifications rows).
 * That was wrong for one decisive reason: it does not conserve. Over the 7 fulfillment days to
 * 2026-09-02 — labor $12,017.65, units sold 26,760, recorded picks 18,355:
 *
 *   picked-based rate x units sold  =  26,760 x $0.6547  =  $17,520
 *   actual fulfillment payroll                           =  $12,018    <- 46% over-allocated
 *
 * Summed across every show in the week, the picking charge exceeded real payroll by $5,500. An
 * allocation whose parts do not add back to the whole is wrong however carefully each part is
 * computed. Units sold reconciles by construction: $0.449 x 26,760 = $12,015.
 *
 * A CORRECTION TO AN EARLIER READING OF THIS. The first version of this comment claimed the
 * picked count was structurally under-recorded, citing recorded picks at 65% of units sold over
 * 7 days, 82% over 14, 77% over 30 and 54% over 60. Those aggregates were an artifact of the
 * pack-station rollout, not of operator discipline: measured per cohort, coverage of orders that
 * actually SHIPPED ran 0% through early July, 44% the week of 07-27, then 86%, 91%, 97%, 97%,
 * 97%. Recording is now essentially complete and the picked count can be trusted.
 *
 * What the picked-vs-sold gap actually measures is BACKLOG. Weekly outflow ranged from 45% to
 * 112% of inflow through August (the week of 08-17 picked MORE than it sold, catching up on
 * 08-10), and across four full weeks 83,700 units sold against 69,707 picked — a backlog build
 * of ~14,000 units. So `picked_pct_of_sold` below 100% means picking is running behind sales,
 * NOT that picks are going unrecorded.
 *
 * THE HONEST CAVEAT OF THE UNITS-SOLD DENOMINATOR, stated plainly: while that backlog grows,
 * this rate UNDER-charges. Labor paid in the window picked fewer units than the window sold, so
 * the picking cost still owed on the unpicked remainder never lands on any show. Cost per unit
 * PICKED ($0.601 over 14 days vs $0.520 per unit sold) is the backlog-independent figure and is
 * returned alongside for exactly that comparison. Units sold is kept as the allocation basis
 * because it matches a period's real payroll to that period's real sales; the two converge as
 * the window lengthens past the batch cycle and diverge when the warehouse falls behind.
 *
 * POOLED, NOT AVERAGED. Sums cents over the whole window and divides by units over the whole
 * window. A mean of daily rates would weight a quiet day the same as a busy one, which is not
 * the rate the business paid.
 *
 * WHAT IT REUSES VERBATIM — the payroll gate is never reimplemented here:
 *   • employeeCostForDay  — which uses isPayableShift / paidShiftHours / isOpenShift, the 04:00
 *     fulfillment-day bucketing, and the MAX_PLAUSIBLE_PUNCH_HOURS forgotten-clock-out guard.
 *     Called once per day in the window and summed.
 *   • perUnitCents        — so "no money" or "no units" reads as null, never $0.00.
 * The only thing this module adds is the summation across days.
 */

import { employeeCostForDay, perUnitCents, type CostEmployee, type CostShift, type EmployeeDayCost, type OpenPunch } from '@/lib/shipping/pickCostEconomics';
import { SHOP_TIMEZONE } from '@/lib/shipping/pickerPerformance';

/** Window volume, straight from the two aggregate RPCs (migrations 122 and 123). */
export interface WindowVolume {
  /** 123: units sold excluding CANCELLED — THE allocation denominator. */
  sold_units: number;
  sold_orders: number;
  cancelled_orders: number;
  /** 122: units and boxes actually recorded as picked — diagnostics only. */
  picked_units: number;
  boxes: number;
}

export interface TrailingFulfillmentRate {
  days: number;
  sold_units: number;
  sold_orders: number;
  cancelled_orders: number;
  picked_units: number;
  boxes: number;
  /**
   * picked ÷ sold, as a percentage. Below 100% means picking is running BEHIND sales (a backlog
   * is building) — it is NOT a recording-coverage figure. Coverage of shipped orders is ~97%.
   * See the header for why that distinction matters to how this rate should be read.
   */
  picked_pct_of_sold: number | null;

  payable_hours: number;
  payable_cents: number;
  pending_hours: number;        // completed punches awaiting manager confirmation
  pending_cents: number;
  live_hours: number;           // still clocked in (a night punch inside the window)
  live_cents: number;
  suspect_hours: number;        // forgotten clock-outs — excluded from every figure below
  suspect_punches: number;

  /** Confirmed-only, per unit SOLD. Understates while confirmations are outstanding. */
  cents_per_unit: number | null;
  /** Everything that will be paid: confirmed + pending + live. THE allocation rate. */
  cents_per_unit_projected: number | null;

  /** Diagnostics on the OLD basis — what the rate would have been per recorded pick. */
  cents_per_picked_unit_projected: number | null;
  cents_per_box_projected: number | null;
}

/**
 * Pool `dayKeys` (fulfillment-day keys, 'YYYY-MM-DD') into one rate. `volume` MUST come from the
 * same window — zonedDayRangeUtcMs over the same first/last key — or the numerator and
 * denominator cover different time.
 */
export function trailingFulfillmentRate(
  employees: ReadonlyArray<CostEmployee>,
  shifts: ReadonlyArray<CostShift>,
  dayKeys: ReadonlyArray<string>,
  volume: WindowVolume,
  tz: string = SHOP_TIMEZONE,
  openPunches: ReadonlyArray<OpenPunch> = [],
  nowMs: number = Date.now(),
): TrailingFulfillmentRate {
  const pooled: EmployeeDayCost = {
    employee_id: '', payable_hours: 0, payable_cents: 0,
    pending_hours: 0, pending_cents: 0, live_hours: 0, live_cents: 0,
    suspect_hours: 0, suspect_punches: 0,
  };

  for (const day of dayKeys) {
    // Crew-wide: EVERY fulfillment hour on the clock that day, including hours that produced no
    // boxes — packing, receiving, restocking, cleanup and training all write no verification
    // row, and all of it is real fulfillment cost. Same reasoning as buildFulfillmentEconomics'
    // crew block. (Measured: nobody currently has fulfillment_track set to 'packer' at all, so
    // any track-based split would silently drop most of the crew.)
    for (const c of employeeCostForDay(employees, shifts, day, tz, openPunches, nowMs).values()) {
      pooled.payable_hours += c.payable_hours;
      pooled.payable_cents += c.payable_cents;
      pooled.pending_hours += c.pending_hours;
      pooled.pending_cents += c.pending_cents;
      pooled.live_hours += c.live_hours;
      pooled.live_cents += c.live_cents;
      pooled.suspect_hours += c.suspect_hours;
      pooled.suspect_punches += c.suspect_punches;
    }
  }

  const projectedCents = pooled.payable_cents + pooled.pending_cents + pooled.live_cents;

  return {
    days: dayKeys.length,
    sold_units: volume.sold_units,
    sold_orders: volume.sold_orders,
    cancelled_orders: volume.cancelled_orders,
    picked_units: volume.picked_units,
    boxes: volume.boxes,
    picked_pct_of_sold: volume.sold_units > 0 ? (volume.picked_units / volume.sold_units) * 100 : null,

    payable_hours: pooled.payable_hours,
    payable_cents: pooled.payable_cents,
    pending_hours: pooled.pending_hours,
    pending_cents: pooled.pending_cents,
    live_hours: pooled.live_hours,
    live_cents: pooled.live_cents,
    suspect_hours: pooled.suspect_hours,
    suspect_punches: pooled.suspect_punches,

    cents_per_unit: perUnitCents(pooled.payable_cents, volume.sold_units),
    cents_per_unit_projected: perUnitCents(projectedCents, volume.sold_units),

    cents_per_picked_unit_projected: perUnitCents(projectedCents, volume.picked_units),
    cents_per_box_projected: perUnitCents(projectedCents, volume.boxes),
  };
}
