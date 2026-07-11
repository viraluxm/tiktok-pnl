-- 055_shifts_source_rule_id.sql
-- Recurring-shift history loss fix (materialization). Recurring instances were a
-- READ-ONLY projection of shift_rules (migration 047) — deleting/deactivating a rule
-- erased its past projected hours because they were never stored rows. The fix
-- MATERIALIZES past recurring days as real `shifts` rows so worked history survives
-- any change to (or deletion of) the rule.
--
-- This migration adds the marking + idempotency + survival guarantees; the daily cron
-- and the pre-mutation freeze (app side) do the actual materializing.
--
-- Additive + idempotent. `shifts` already exists (044); nothing else is touched.

-- MARKING: which rule a materialized row came from (NULL = a plain one-off shift).
-- The row also carries its OWN start_time/end_time, copied at freeze time — a snapshot,
-- so a later edit to the rule's pattern can never alter frozen history.
alter table public.shifts
  add column if not exists source_rule_id uuid;

-- FK: ON DELETE SET NULL — NEVER cascade. When a rule is deleted (app OR direct SQL),
-- its materialized rows SURVIVE and simply become ordinary one-off shifts (link lost,
-- hours kept). ON DELETE CASCADE here would re-create the exact bug we are fixing.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shifts_source_rule_id_fkey'
  ) then
    alter table public.shifts
      add constraint shifts_source_rule_id_fkey
      foreign key (source_rule_id) references public.shift_rules(id) on delete set null;
  end if;
end $$;

-- IDEMPOTENCY: at most one materialized row per (employee, date, rule). A rule emits
-- ≤1 instance per date, so this is the exact natural key — materializing twice (cron
-- re-run, backfill, freeze + cron overlap) is a no-op via ON CONFLICT DO NOTHING.
--
-- NON-partial ON PURPOSE: PostgREST/supabase-js upsert(onConflict: '...') can only infer
-- a NON-partial index (it can't send a partial index's WHERE predicate). A one-off shift
-- has source_rule_id = NULL, and Postgres treats NULLs as DISTINCT in a unique index, so
-- this still never constrains hand-entered one-off shifts — a person can have multiple
-- NULL-source shifts on the same day. Only materialized (source_rule_id NOT NULL) rows
-- are actually made unique.
create unique index if not exists idx_shifts_materialized_unique
  on public.shifts (employee_id, date, source_rule_id);

-- Lookup index for the generator's exclusion set + the freeze's "already materialized?"
-- check (all reads are per rule).
create index if not exists idx_shifts_source_rule_id
  on public.shifts (source_rule_id)
  where source_rule_id is not null;
