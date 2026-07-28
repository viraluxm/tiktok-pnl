-- 067_shipment_verification_pick_started_at.sql
-- Phase 1 (refinement) of Fulfillment Picker Performance: true per-box pick timing.
--
-- Adds a single nullable timestamp capturing when a box/order group was LOADED at the
-- packing station. Combined with the existing verified_at (completion time), it yields the
-- real box-picking duration (verified_at - pick_started_at) instead of the coarse
-- between-completions gap. Purely additive — no new table, no second write, no RLS change,
-- no trigger, no change to existing columns/constraints/data.
--
--   pick_started_at → set on the SAME idempotent (user_id, group_key) upsert the confirm
--                     route already performs. Nullable: historical rows (and any confirm
--                     from a client that doesn't send it) keep NULL and simply show no
--                     Average Pick Time (never a fake 0).
--
-- No averages/durations are persisted — only the two raw timestamps; all KPIs are computed
-- at read time. RLS unchanged (existing per-user policies already cover the new column).

alter table public.shipment_verifications
  add column if not exists pick_started_at timestamptz;
