-- 045_org_settings.sql — Identity/Auth phase, CHUNK 9 (support): per-org settings.
-- Holds the KPI-dashboard allowlist (which store logins see the worker-KPI dashboard) so
-- future new shops don't auto-inherit it. Additive, transaction-wrapped, idempotent.
-- Reverse: drop table public.org_settings;

begin;

create table if not exists public.org_settings (
  org_id                   uuid primary key references public.organizations(id) on delete cascade,
  kpi_dashboard_store_ids  uuid[] not null default '{}',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

drop trigger if exists org_settings_set_updated_at on public.org_settings;
create trigger org_settings_set_updated_at before update on public.org_settings
  for each row execute function public.set_updated_at();

alter table public.org_settings enable row level security;
drop policy if exists "os org read"   on public.org_settings;
drop policy if exists "os owner write" on public.org_settings;
create policy "os org read"   on public.org_settings for select using (public.is_org_member(org_id));
create policy "os owner write" on public.org_settings for all
  using (public.is_store_owner_in_org(org_id)) with check (public.is_store_owner_in_org(org_id));

-- Seed the allowlist: lots-of-steals + Snore only.
insert into public.org_settings (org_id, kpi_dashboard_store_ids)
values ('6deb8558-7cd3-4ff5-8522-63071f9882ff',
        array['afd1c76e-1d92-4c7d-9edf-0468ae7aa3df', '1d71a4c9-16b1-45f2-858e-64b41c548e9e']::uuid[])
on conflict (org_id) do update set kpi_dashboard_store_ids = excluded.kpi_dashboard_store_ids;

commit;
