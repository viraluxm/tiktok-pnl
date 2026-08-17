-- 104: live_auction_item_skus.short_at_bind — per-order-line "this could not be filled".
--
-- THE FACT. A host sells a SKU during a live that is already at zero. Nothing stops the sale.
-- The order arrives unbound, the team binds it after, and the bind draws stock that isn't there.
-- THAT is the moment the system knows the order can't be filled — hours before anyone buys a
-- label, and long before a picker scans it. This column records it at that moment so the pick
-- screen can be a pure read.
--
-- WHY PER LINE, NOT PER SKU. Sell 10 with 8 on hand: the first 8 orders bind fine and only the
-- last 2 are short. Only those 2 boxes should warn. A SKU-level flag would light up all 10 —
-- the false-positive noise this design exists to avoid. live_auction_item_skus IS the order-line
-- grain: one row per (auction_item_id, inventory_sku_id), and auction_item_id resolves to the
-- order through live_auction_items.client_idempotency_key.
--
-- WHY WRITTEN, NOT DERIVED. The obvious alternative — read inventory_skus.qty_on_hand at scan
-- time — is wrong twice over. It is a global running counter, so it cannot say whether THIS
-- order's units were the short ones, and it isn't even the number the bind decides on: the
-- OUT_OF_STOCK decision is made against sku_batches.qty_remaining (the FIFO layers), not
-- qty_on_hand. A written fact is decided once, by the code that actually knows, and never moves.
--
-- IMMUTABLE. An order either was short at bind or it wasn't. No time window, no clearing, no
-- recomputation — nothing about the past changes when stock is replenished later.
--
-- ADDITIVE AND INERT ON ITS OWN. Nullable, NO default, NO backfill, no index, no constraint, no
-- RLS change (the table's existing owner policies cover it). Nothing reads or writes this column
-- until migration 105 replaces the two bind RPCs, so applying THIS file alone changes no
-- behaviour anywhere — which is exactly why it ships and is applied by itself.
--
-- NULL SEMANTICS. null = "bound before this shipped, or the bind wasn't a sale" and reads as NOT
-- short. That makes the ordering safe in the only direction it can go: column first, RPCs second.
-- If 104 is applied and 105 never is, every row stays null and no band ever renders. The reverse
-- ordering is impossible — 105 cannot be applied against a table without this column.

alter table public.live_auction_item_skus
  add column if not exists short_at_bind boolean;

comment on column public.live_auction_item_skus.short_at_bind is
  'true = this order line drew stock that was not on hand at bind time (the allow_negative path '
  'in lensed_log_auction / lensed_log_auction_as). Immutable: set once at bind, never cleared, '
  'never recomputed. null = pre-dates the feature, or not a sale. Surfaced as the OUT OF STOCK '
  'band on the pick card.';
