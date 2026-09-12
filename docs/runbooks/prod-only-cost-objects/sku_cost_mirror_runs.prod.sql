-- VERBATIM RECONSTRUCTION of the LIVE public.sku_cost_mirror_runs table, from
-- information_schema / pg_catalog introspection on 2026-09-11.
--
-- THIS FILE IS A SNAPSHOT, NOT A MIGRATION. Do not apply it. It exists so the repo
-- records what production actually contains. See ../prod-only-cost-objects.md.

create table public.sku_cost_mirror_runs (
  id          bigint      not null default nextval('sku_cost_mirror_runs_id_seq'::regclass),
  ran_at      timestamptz not null default now(),
  skus_seen   integer     not null,
  layers_seen integer     not null,
  candidates  integer     not null,
  rows_changed integer    not null,
  duration_ms integer     not null,
  constraint sku_cost_mirror_runs_pkey primary key (id)
);

create index idx_sku_cost_mirror_runs_ran_at
  on public.sku_cost_mirror_runs using btree (ran_at desc);

-- RLS is ENABLED with NO policies (relrowsecurity = true, relforcerowsecurity = false).
-- Nothing but the table owner / service_role can read it; the writer is SECURITY DEFINER.
alter table public.sku_cost_mirror_runs enable row level security;
