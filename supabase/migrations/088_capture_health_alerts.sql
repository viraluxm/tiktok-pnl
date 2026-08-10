-- 088_capture_health_alerts.sql
--
-- Alert-state (dedup) table for the capture-health dead-man's-switch cron
-- (GET /api/cron/capture-health). One row per store; the cron upserts last_notified_at so it
-- does not re-alert on every 5-minute tick. Purely additive — new table, new name; it replaces
-- and alters nothing.
--
-- Prefix note: 085/086 belong to the unmerged scheduling-v1 branch, 087 is the member inventory
-- reorder function (feat/member-inventory-scope). 088 is the next free slot above every claimed
-- prefix.
--
-- Written by the cron via the service role. RLS enabled with NO policies: anon/authenticated get
-- no access; service_role bypasses RLS. This table is NOT on the capture/order-sync read path.

create table public.capture_health_alerts (
  store_id uuid primary key,
  last_notified_at timestamptz not null,
  last_gap_min numeric,
  updated_at timestamptz not null default now()
);

alter table public.capture_health_alerts enable row level security;
-- No policies by design: service_role only.
