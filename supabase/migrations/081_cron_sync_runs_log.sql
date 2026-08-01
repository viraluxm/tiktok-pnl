-- 081_cron_sync_runs_log.sql
-- Observability for the sync-orders cron. Each run appends its summary here (dry-run AND write),
-- so the log-only ramp's would-write counts + read-load numbers are queryable (the cron writes
-- nothing else in dry-run, and Vercel console logs aren't). This is NOT order data — a dry run still
-- "persists nothing" of consequence; this is a telemetry row. Small, append-only.
create table if not exists public.cron_sync_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  is_write boolean not null,
  summary jsonb not null
);
create index if not exists idx_cron_sync_runs_ran_at on public.cron_sync_runs (ran_at desc);
