-- 052_shifts_open_shift.sql
-- "Open shift" = an in-progress shift with a NULL end_time (a STATE). Migration 044
-- created shifts.end_time as `time NOT NULL`; make it nullable so a shift can be saved
-- with only a start, then closed later.
--
-- Additive + safe:
--   * Every existing row has an end_time (the column was NOT NULL), so dropping the
--     constraint changes nothing for them.
--   * The partial unique index starts EMPTY (no open shifts exist yet), so it can never
--     fail to create on current data.
--   * No existing column is touched.

alter table public.shifts alter column end_time drop not null;

-- GUARD (server-side, not UI-only): at most ONE open shift per employee. A second
-- open shift for the same person raises unique_violation even if the UI check is
-- bypassed or two inserts race. employee_id is a global PK, so scoping by it alone is
-- sufficient (employees are already user_id-scoped).
create unique index if not exists idx_shifts_one_open_per_employee
  on public.shifts (employee_id) where end_time is null;
