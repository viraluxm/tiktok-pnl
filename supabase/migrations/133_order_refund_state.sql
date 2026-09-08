-- 133_order_refund_state.sql
--
-- What Lensed knows about refunds and cancellations, so the pack station cannot ship an order
-- that has already been paid back to the buyer.
--
-- THE INCIDENT (2026-09-08). A picker held a Snore label for a 6-order combine box from
-- 2026-08-14. The parcel was never dispatched, TikTok refunded the buyer, and all six orders
-- closed as COMPLETED with "Refund issued" in Seller Center. Lensed knew none of it:
-- parseOrder (syncCore.ts:429) captures status, tracking, GMV and fees — no refund or
-- cancellation field exists anywhere in synced_order_ids. The box was only spared because
-- COMPLETED happens to sit in the scanner's DO_NOT_PACK set. The same refund arriving while the
-- order was AWAITING_COLLECTION would have shipped: goods and postage spent on a refunded order,
-- with nothing anywhere to object.
--
-- The exposure is not hypothetical: 24,748 orders were pack-ready at the time, ~2,435 of them
-- older than 14 days, against a self-reported late-dispatch rate of 21.96%. Late dispatch is
-- exactly what triggers TikTok's automatic refund.
--
-- The APIs were already written and unused for this purpose — fetchCancellations and fetchReturns
-- in src/lib/tiktok/client.ts. pnl_refund_events exists but is P&L-shaped (business date, subtotal
-- cents) and empty; it answers "what did refunds cost" and cannot answer "may I ship this box",
-- which needs the live per-order state keyed for a point lookup at scan time.
--
-- One row per (order, kind): an order can carry both a cancellation and a return record, and they
-- use different status vocabularies, so they are kept apart rather than overwriting each other.
--
-- blocks_packing is stored, not derived at read time, so that the scanner's hot path is an index
-- lookup rather than a string match — but the RAW status is kept beside it, because the decision
-- rests on an enum TikTok owns and we cannot enumerate. A wrong call is then visible in the data
-- and re-derivable, instead of silently wrong forever. The rule lives in
-- src/lib/shipping/refundGuard.ts (blocksPacking) and is: BLOCK UNLESS TIKTOK SAYS THE REQUEST
-- FAILED. Holding a box costs a second look; shipping a refunded one cannot be undone.
--
-- Deploy notes: Class A. New table, no dependency on any existing one, nothing locked. Safe to
-- apply mid-show.

set lock_timeout = '3s';

create table if not exists public.order_refund_state (
  user_id           uuid        not null,
  store_id          uuid,
  order_id          text        not null,
  kind              text        not null,             -- 'cancellation' | 'return'
  ref_id            text,                             -- TikTok's return_id / cancellation id
  status            text        not null,             -- RAW TikTok status, never normalised away
  blocks_packing    boolean     not null,             -- refundGuard.blocksPacking(status)
  return_type       text,
  reason            text,
  refund_amount     numeric,
  tiktok_created_at timestamptz,
  tiktok_updated_at timestamptz,
  synced_at         timestamptz not null default now(),
  primary key (user_id, order_id, kind)
);

-- The scanner's question is "does ANY record block this order", asked for the handful of orders
-- in one box. Partial, because the blocking rows are the only ones that path cares about.
create index if not exists idx_order_refund_state_blocking
  on public.order_refund_state (order_id)
  where blocks_packing;

-- For the operator-facing "what is being held, and why" review.
create index if not exists idx_order_refund_state_store_time
  on public.order_refund_state (store_id, tiktok_updated_at desc);

-- Service-role writes only (the ingest route uses the admin client); no public policies, matching
-- tracking_correction_log (066) and channel_resolve_conflict_log (072).
alter table public.order_refund_state enable row level security;

reset lock_timeout;
