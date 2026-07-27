// ASP (Average Selling Price) goal = a target multiple of an auction item's break-even cost.
//
// UNIFIED at 4× across categories, matching the extension overlay (PRs #82/#83). Both squish
// (was already 4×) and electronics (was 3×) realize ~2× cost at the median, so one 4× bar makes
// hosts directly comparable and keeps extension + web on ONE definition. This is the SINGLE
// source of truth — every web hit-rate / ASP-goal computation imports it; there are no hardcoded
// multipliers left. Change this one number to retune (or make it category-relative later,
// mirroring the extension's per-category map).
export const ASP_GOAL_MULTIPLIER = 4;

// ASP goal in cents from an item's break-even (Σ unit_cost_cents_snapshot × qty). Recomputed at
// display time from the SAME cost basis shown next to it — never read from the stored
// live_auction_items.expected_price_cents (which is vestigial; see below). Null cost → null goal.
export function aspGoalCents(breakEvenCents: number | null | undefined): number | null {
  if (breakEvenCents == null || !Number.isFinite(breakEvenCents)) return null;
  return breakEvenCents * ASP_GOAL_MULTIPLIER;
}

// NOTE: live_auction_items.expected_price_cents is VESTIGIAL. lensed_log_auction still writes it
// (as cost × 3, and on a not_sold→sold flip the snapshot cost can be overwritten while this value
// stays frozen — producing 6×-looking rows). Nothing reads it for the goal anymore; the goal is
// always recomputed via aspGoalCents() from the item's current break-even. Do not trust the
// stored column.
