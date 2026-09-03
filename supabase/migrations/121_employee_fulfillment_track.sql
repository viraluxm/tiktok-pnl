-- 121 — employees.fulfillment_track: picker / packer / flex sub-type
--
-- WHY A NEW COLUMN AND NOT A NEW `role` VALUE
--
-- The literal string 'fulfillment' in employees.role is a hard gate in eight places, and the
-- worst of them fails SILENTLY. validatePicker() (src/lib/shipping/pickerPerformance.ts)
-- requires role === 'fulfillment' before /api/shipping/confirm will stamp a picker on a box:
-- change role to 'picker' and every completed box goes Unassigned with no error anywhere.
-- The others: /api/station/employees (picker dropdown), ShippingTab (eligible pickers),
-- fulfillment-performance (eligible count), labor.ts (fulfillment labor cost cells),
-- schedule/eligibility.ts (open-shift claims), weeklySchedule.ts + timeclock.ts (role groups).
--
-- So role stays exactly as it is. This column is ADDITIVE and read only for display and
-- grouping on the fulfillment performance view. Nothing gates on it — a 'packer' is still a
-- fully eligible picker everywhere, which is deliberate: a mis-set track must never be able
-- to lock someone out of picking mid-shift.
--
-- NULL = unset, and is the state every existing row starts in. 'flex' is for the people who
-- both pick and pack or float onto cleanup, and is a real answer rather than a missing one.
--
-- LOCK FOOTPRINT — Class A (appliable during a live show)
--   • ADD COLUMN nullable, no default → catalog-only, no table rewrite.
--   • ADD CONSTRAINT CHECK does take ACCESS EXCLUSIVE and scan, but employees holds 41 rows,
--     so the scan is instant. Run each statement group in its own transaction with
--     `set local lock_timeout = '3s'` so a blocked attempt fails fast instead of queueing
--     behind a live-path reader.
--   • employees IS read by /api/shipping/confirm during a show (picker validation), so this
--     is NOT exempt from the write gate — it is Class A, not ungated.

begin;
set local lock_timeout = '3s';

alter table public.employees add column fulfillment_track text;

comment on column public.employees.fulfillment_track is
  'Fulfillment sub-type: picker | packer | flex. NULL = unset. Display/grouping ONLY — never '
  'a gate. role stays ''fulfillment'' for everyone; see migration 121 header for why.';

commit;

begin;
set local lock_timeout = '3s';

alter table public.employees
  add constraint employees_fulfillment_track_chk
  check (fulfillment_track is null or fulfillment_track in ('picker', 'packer', 'flex'));

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (run after applying; every negative assertion reports the
-- cardinality of the set it examined, per supabase/migrations/CONVENTIONS.md)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1) Column exists, is nullable, has no default (proves no rewrite happened):
--
--    select column_name, is_nullable, column_default
--    from information_schema.columns
--    where table_name = 'employees' and column_name = 'fulfillment_track';
--    -- expect: fulfillment_track | YES | NULL
--
-- 2) role is UNTOUCHED — the whole point of this migration. Positive assertion, so it
--    cannot pass vacuously:
--
--    select role, count(*) as employees
--    from public.employees group by 1 order by 1;
--    -- expect exactly the pre-migration distribution: fulfillment | 17, host | 24
--
-- 3) Every row starts unset, and the check constraint rejects a bad value:
--
--    select count(*) as rows_examined,
--           count(*) filter (where fulfillment_track is null) as unset
--    from public.employees;
--    -- expect: rows_examined = unset (all NULL)
--
--    -- must ERROR (proves the constraint can fail at all):
--    -- update public.employees set fulfillment_track = 'forklift'
--    --   where id = (select id from public.employees limit 1);
--
-- 4) `authenticated` can actually SELECT and UPDATE the new column.
--
--    employees carries a TABLE-level grant to authenticated (DELETE, INSERT, REFERENCES,
--    SELECT, TRIGGER, TRUNCATE, UPDATE), which covers every column including new ones —
--    information_schema.column_privileges merely expands that grant per column. But a
--    genuine column-level grant would NOT extend, and the failure mode is a 400 from
--    PostgREST the first time the roster saves a track. So assert it directly rather than
--    inferring it; this is a POSITIVE assertion and cannot pass vacuously:
--
--    select has_column_privilege('authenticated', 'public.employees', 'fulfillment_track', 'SELECT') as can_select,
--           has_column_privilege('authenticated', 'public.employees', 'fulfillment_track', 'UPDATE') as can_update;
--    -- expect: t | t   (if either is f, add: grant select, update (fulfillment_track)
--    --                  on public.employees to authenticated;)
--
-- 5) capture_events kept landing across the window (Class A discipline):
--
--    select count(*) from public.capture_events;   -- before, then after
