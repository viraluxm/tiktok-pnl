-- 086_collapse_shift_templates.sql
-- Collapse the two-schedule-representation into ONE. shift_templates (085) was added to back a
-- menu-driven onboarding picker with headcount caps; that approach is reversed. shift_rules already
-- models arbitrary per-person recurring schedules (multi-element days_of_week + free times) and the
-- team tab already edits it. So: drop shift_templates and every template_id link, and point a
-- materialized instance back at the RULE that spawned it instead of a template.
--
-- ⚠️ MIGRATION LEDGER: this database has NO migration ledger. Migrations are applied BY HAND and the
--    repo file is the ONLY record of what has run. 086 is the next prefix above the APPLIED 085.
--    ➜ BEFORE HAND-APPLYING, inspect the LIVE schema — DB state is UNVERIFIED against this repo.
--
-- SAFE BECAUSE EMPTY (verified at authoring, 2026-08-09): public.shift_instances and
--    public.attendance_events both had 0 rows, so there is NO data migration — dropping columns and
--    swapping constraints is pure structure. shift_rules held only the 25 (soon template-less)
--    fulfillment patterns; shift_templates held 24 seeded rows that this migration deletes with the
--    table. RE-VERIFY both tables are still empty before applying; if shift_instances has ANY row,
--    STOP — the new UNIQUE(employee_id, shift_date) could then fail on real data and this needs review.
--
-- REVERSAL NOTE: this undoes the template-specific parts of 085 (shift_templates + the three
--    template_id columns/FKs/indexes). The rest of 085 (shift_instances, shift_claims,
--    employee_access_tokens, attendance_events, employees.phone) stays. Release/claim board, drop
--    counting, tokens, SMS and the /s/[token] page are unaffected — they operate on shift_instances,
--    never on templates.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- DESIGN CONSTRAINT — ONE SHIFT PER PERSON PER DAY (documented so it's a known boundary, not a surprise)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Both the shift_instances UNIQUE constraint and the forward-materializer REGENERATION GUARD key on
-- (employee_id, shift_date). This ASSUMES at most one shift per person per calendar day — true for
-- this operation today: a host works one 10h shift, fulfillment one 8h shift.
--
--   ⇒ IF DOUBLE SHIFTS ARE EVER INTRODUCED: this key is no longer sufficient. Both the UNIQUE
--     constraint here AND the guard must add `starts_at`, and attendance_events needs a `starts_at`
--     column added to match (so a per-day guard becomes a per-shift guard). That is a schema change,
--     not a code tweak — treat this comment as the trigger for it.
--
-- Released-instance caveat (unchanged from 085's reasoning): employee_id is NULLABLE (a released
-- instance has employee_id = NULL, released_by = the original person). Postgres treats NULLs as
-- DISTINCT in a UNIQUE constraint, so UNIQUE(employee_id, shift_date) does NOT by itself stop a
-- released slot from being re-materialized for its releaser. That is handled — as before — by the
-- forward materializer's NOT EXISTS check against attendance_events ('released'/'missed_unfilled'
-- for that employee_id + shift_date). The UNIQUE constraint is the idempotency backstop for the
-- normal (scheduled/claimed, non-null employee) case only.

begin;

-- 1. shift_instances.template_id → GONE. Dropping the column automatically drops its FK
--    (shift_instances_template_id_fkey), the idx_shift_instances_template index, AND the old
--    UNIQUE(template_id, shift_date, employee_id) constraint (it depended on the column).
alter table public.shift_instances drop column if exists template_id;

-- 2. shift_instances.shift_rule_id — points back at the RULE that spawned the instance. Nullable +
--    ON DELETE SET NULL DELIBERATELY: a released/claimed/worked instance must survive deletion of
--    its rule. Everything the instance needs (employee_id, starts_at, ends_at, shift_date, store_id)
--    is already denormalized onto the row, so a null link loses nothing operationally.
alter table public.shift_instances add column if not exists shift_rule_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shift_instances_shift_rule_id_fkey') then
    alter table public.shift_instances
      add constraint shift_instances_shift_rule_id_fkey
      foreign key (shift_rule_id) references public.shift_rules(id) on delete set null;
  end if;
end $$;
create index if not exists idx_shift_instances_shift_rule on public.shift_instances(shift_rule_id);

-- 3. New identity: UNIQUE(employee_id, shift_date) — one shift per person per day (see header).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shift_instances_employee_date_unique') then
    alter table public.shift_instances
      add constraint shift_instances_employee_date_unique unique (employee_id, shift_date);
  end if;
end $$;

-- 4. attendance_events.template_id → GONE. Dropping the column automatically drops its FK
--    (attendance_events_template_id_fkey) and the old idx_attendance_events_guard (which was on
--    (employee_id, template_id, shift_date)). Rebuild the guard index on (employee_id, shift_date)
--    to back the materializer's NOT EXISTS regeneration check. (idx_attendance_events_employee_period
--    on (employee_id, pay_period_start), used by drop counting, is untouched.)
alter table public.attendance_events drop column if exists template_id;
create index if not exists idx_attendance_events_guard
  on public.attendance_events(employee_id, shift_date);

-- 5. shift_rules.template_id → GONE. Dropping the column automatically drops its FK
--    (shift_rules_template_id_fkey) and the idx_shift_rules_template index. shift_rules is now the
--    single schedule model again; the team tab (which never set template_id) is unaffected.
alter table public.shift_rules drop column if exists template_id;

-- 6. Drop shift_templates itself (now unreferenced — all three template_id FKs are gone above).
--    Takes the 24 seeded template rows with it. Its indexes (pkey, user, store, active) go too.
drop table if exists public.shift_templates;

commit;
