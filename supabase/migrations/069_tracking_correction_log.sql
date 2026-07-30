-- 066_tracking_correction_log.sql
-- Audit trail for every tracking_number OVERWRITE performed by /api/shipping/sync-tracking's
-- stale-correction path. The null-FILL path (writing a tracking where we had none) is not
-- destructive and is not logged here; this table exists specifically because correction
-- REPLACES a stored value, so a bad sweep must be traceable AND reversible: old_tracking is
-- the pre-overwrite value, so a restore is `set tracking_number = old_tracking` keyed by id.
--
-- Why corrections happen: TikTok re-labels combine shipments (one consolidated label -> N
-- per-package labels), so a stored non-null tracking can be SUPERSEDED. The COALESCE-safe
-- writer never overwrote a non-null value, so stale trackings were frozen and their physical
-- labels could not resolve at the pack station. Correction overwrites from getOrderById (the
-- authoritative live value), guarded to never write an empty/missing tracking.

create table if not exists public.tracking_correction_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  store_id          uuid,
  order_id          text not null,
  old_tracking      text,                 -- pre-overwrite stored value (the stale tracking) — enables reversal
  new_tracking      text not null,        -- value written (live from getOrderById; always non-empty)
  combine_group_id  text,                 -- auto_combine_group_id at correction time (re-label grouping)
  source            text not null default 'sync-tracking',
  corrected_at      timestamptz not null default now()
);

create index if not exists idx_tracking_correction_log_order on public.tracking_correction_log (order_id, corrected_at desc);
create index if not exists idx_tracking_correction_log_store_time on public.tracking_correction_log (store_id, corrected_at desc);

-- Service-role writes only (the route uses the admin client); no public policies.
alter table public.tracking_correction_log enable row level security;
