-- 073_period_labor.sql
-- Stores the MANUAL packer-labor figure per Dashboard period (host labor is computed live from
-- live_sessions and never stored). Deliberately NOT wired to shifts/computePay — the Dashboard
-- labor line is a period-level cost, independent of the payroll pay calc.

create table if not exists public.period_labor (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  period_start       date not null,
  period_end         date not null,
  packer_labor_cents integer not null default 0,   -- manager-entered; hosts are computed, not stored here
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, period_start, period_end)
);

comment on table public.period_labor is
  'Manual packer-labor input per Dashboard period. Host labor is computed from live_sessions; only the packer figure is stored.';

alter table public.period_labor enable row level security;

create policy period_labor_owner_all on public.period_labor
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
-- service_role bypasses RLS. No anon access.
revoke all on public.period_labor from anon;
