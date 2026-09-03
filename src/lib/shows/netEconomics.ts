/**
 * Net-net economics for one live show — what a unit actually earns after LABOR, and what the
 * show earns per hour it was on air.
 *
 * WHAT "NET-NET" MEANS HERE
 *   base profit           product margin: won price (or net payout, once fees are in) − COGS
 *   − picking labor       what it cost the warehouse crew to move those units
 *   − host pay            what it cost to sell them on air
 *   = net-net
 * The Shows tab's existing Gross profit card stops at the first line. On a real show measured
 * 2026-09-03 that was +$178.65, which reads like a profitable hour of selling; the two labor
 * lines below it came to $363 and put the show at −$184. Both figures are true — they just
 * answer different questions, so both are shown rather than one replacing the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PICKING COST IS AN ALLOCATION, NOT A MEASUREMENT — and that is not a shortcut
 *
 * A show's units are not picked during the show. They are picked over the following day or two,
 * in boxes that COMBINE orders from several shows, by a crew whose hours cannot be split back
 * out per show. There is no measurement to make. So the honest figure is the crew's trailing
 * cost per unit picked, multiplied by this show's units — an allocation, labelled as one
 * everywhere it surfaces.
 *
 * It is trailing rather than same-day on purpose. Per fulfillment day 2026-08-27..09-02 the
 * crew rate ran $0.376, $0.492, $0.500, $0.759, $0.841, $0.394 per unit — a 2.2x spread driven
 * by which crew worked and how much they had queued, not by anything the show did. Charging a
 * show the rate of whichever day it happened to fall on would decide its profitability by
 * coincidence. Over the same 7 days the pooled rate is $0.556 and moves slowly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOST PAY IS MEASURED, VIA LIVE DURATION × RATE
 *
 * Checked against the punch clock over 9 days: host punch hours 505.9 vs live-session hours
 * 509.0 — hosts are paid essentially exactly their air time, so duration × rate is not a
 * proxy standing in for the truth, it agrees with it to 0.6%.
 *
 * The caveat is per-show, not aggregate: a 13-minute show that sold 10 items gets charged 13
 * minutes of host pay, while the host was really paid for the whole block around it. So SHORT
 * shows understate host cost. Aggregate reporting is unaffected; a single tiny show reads
 * better than it was, and `short_show` flags it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A MISSING COST IS NEVER ZERO
 *
 * Every result below is null when an input it needs is absent, and `missing` says which. That
 * is the whole reason this module returns a shape instead of numbers: 7% of sessions have no
 * host_id, and treating an unknown host cost as $0 would silently print a better net-net than
 * the show earned. Blank is honest; zero is a lie that looks like a number. (Same reason
 * perUnitCents in pickCostEconomics.ts returns null rather than 0.)
 */

// A show shorter than this is not a full selling block, so its host-pay line is flagged: the
// host was paid for surrounding time this show is not charged for. 30 minutes clears a genuine
// short show while catching the 10-13 minute fragments that exist in the data.
export const SHORT_SHOW_MS = 30 * 60 * 1000;

export type MissingInput = 'units' | 'duration' | 'host_pay' | 'pick_rate';

export interface ShowNetInput {
  /** Product margin in cents: won−COGS, or payout−COGS once payouts are refreshed. */
  baseProfitCents: number;
  /** Whether baseProfitCents already has TikTok fees taken out. Display only. */
  baseIsNetOfFees: boolean;
  unitsSold: number;
  durationMs: number | null;
  /**
   * Host pay for this show in cents, ALREADY computed server-side (rate x duration) — an
   * individual's hourly_rate must not reach the browser, so the multiplication happens in
   * /api/live/sessions/[id]/net-economics and only the product travels. null when the session
   * has no host mapped, the host row is gone, or the rate is 0/unset.
   */
  hostPayCents: number | null;
  /** Trailing crew cost per unit picked, in cents. null when the window has no costable data. */
  pickCentsPerUnit: number | null;
}

export interface ShowNetResult {
  hostCents: number | null;
  pickCents: number | null;
  netNetCents: number | null;
  netNetPerUnitCents: number | null;
  /** Net-net per HOUR on air, in cents. */
  netPerHourCents: number | null;
  hostPerUnitCents: number | null;
  pickPerUnitCents: number | null;
  liveHours: number | null;
  baseIsNetOfFees: boolean;
  /** Short show → host pay is understated (see the header note). */
  shortShow: boolean;
  /** Which inputs were absent. Non-empty ⇒ at least one figure above is null. */
  missing: MissingInput[];
}

/**
 * The full breakdown. Every derived figure is null unless EVERY input it depends on is present,
 * so a card can render "—" and say why rather than quietly dropping a cost.
 */
export function showNetEconomics(input: ShowNetInput): ShowNetResult {
  const { baseProfitCents, baseIsNetOfFees, unitsSold, durationMs, hostPayCents, pickCentsPerUnit } = input;

  const missing: MissingInput[] = [];
  const hasUnits = Number.isFinite(unitsSold) && unitsSold > 0;
  const hasDuration = durationMs != null && Number.isFinite(durationMs) && durationMs > 0;
  const hasHostPay = hostPayCents != null && Number.isFinite(hostPayCents) && hostPayCents > 0;
  const hasPickRate = pickCentsPerUnit != null && Number.isFinite(pickCentsPerUnit) && pickCentsPerUnit > 0;

  if (!hasUnits) missing.push('units');
  if (!hasDuration) missing.push('duration');
  if (!hasHostPay) missing.push('host_pay');
  if (!hasPickRate) missing.push('pick_rate');

  const liveHours = hasDuration ? durationMs / 3_600_000 : null;

  const hostCents = hasHostPay ? hostPayCents : null;

  // Allocated picking cost: trailing crew rate × this show's units.
  const pickCents = hasPickRate && hasUnits
    ? Math.round(pickCentsPerUnit * unitsSold)
    : null;

  // Net-net requires BOTH labor lines. With one missing, the remaining subtraction would read
  // as a complete answer while omitting a cost — worse than showing nothing.
  const netNetCents = hostCents != null && pickCents != null
    ? baseProfitCents - hostCents - pickCents
    : null;

  return {
    hostCents,
    pickCents,
    netNetCents,
    netNetPerUnitCents: netNetCents != null && hasUnits ? netNetCents / unitsSold : null,
    netPerHourCents: netNetCents != null && liveHours != null ? netNetCents / liveHours : null,
    hostPerUnitCents: hostCents != null && hasUnits ? hostCents / unitsSold : null,
    pickPerUnitCents: hasPickRate ? pickCentsPerUnit : null,
    liveHours,
    baseIsNetOfFees,
    shortShow: hasDuration && durationMs < SHORT_SHOW_MS,
    missing,
  };
}
