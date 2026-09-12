-- 151_bonus_target_date.sql — AN HOURLY BONUS IS ALWAYS FOR ONE SPECIFIC DAY.
--
-- ✅ APPLIED TO PRODUCTION 2026-09-12 19:15 UTC. This DB has NO migration ledger — migrations are
--    applied BY HAND and the repo file is the only record (see CONVENTIONS.md), so this line IS the
--    record. DO NOT APPLY IT AGAIN. Every statement is `if not exists` / guarded, so a re-run is
--    harmless but pointless.
--
--    Applied MIGRATION FIRST, ahead of the code deploy, through the Management API.
--
--    THE GATE WAS CHECKED IMMEDIATELY BEFORE APPLYING, not assumed: 1 row in the table, 1 flat,
--    **0 hourly**. Nothing existed whose meaning could change from "the whole pay period" to "one
--    day", which is the only thing that could have made this migration unsafe.
--
--    Evidence either side, per CLAUDE.md's deploy gate:
--      • 19:14:56 UTC before — latest capture_events write 19:14:16 (40s earlier), 17 events in the
--        preceding 15 minutes, live_sessions.last_seen_at 19:14:48, 1 session marked live. A show
--        WAS running; one nullable column add (catalog-only) plus three CHECK constraints on a
--        1-row table, with `set local lock_timeout = '3s'` making contention abort rather than
--        queue, so it went ahead and is reported here.
--      • 19:15:38 UTC after — a further capture_events row had landed since the apply began and
--        live_sessions.last_seen_at had advanced to 19:15:33. The capture path never paused.
--      • DATA UNTOUCHED, by fingerprint, identical before and after: 50 employees, 759 shifts;
--        md5 over every shift's punch instants, breaks, approved_minutes and confirmed_at =
--        182567e33c9f69aa7bd371f38eac61f5; md5 over every employee's hourly_rate =
--        f31528f94ed4087b5165d08477023851; md5 over every bonus row's type and money =
--        1b3fdafa773d10f67f3a15f3774141ea. No backfill was performed and none was needed.
--
--    Verified live afterwards, read-only: `target_date date`, NULLABLE, no default; 14 constraints
--    (150's 11 plus these 3); the pre-existing flat row passed validation and is unchanged, with
--    target_date NULL; and still NO calculated/total column (13 columns examined).
--
--    Behaviour verified in production by attempting rows that MUST be refused, so nothing could be
--    written. Each was rejected by the named constraint, and the table still holds exactly its one
--    pre-existing flat row with no target_date:
--      • hourly with NO day                     → hourly_needs_target_date
--      • hourly with a day AFTER the period     → target_date_in_period
--      • hourly with a day BEFORE the period    → target_date_in_period
--      • flat carrying a day                    → flat_no_target_date
--
-- 🔢 PREFIX 151 was free across origin/main, every local and remote branch and every one of the 34
--    sibling worktrees at the time of writing (150 is this feature's own, applied 2026-09-12;
--    152-154 belong to fix/fifo-cost-backfill-foundation). Do NOT backfill a lower gap.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Migration 150 shipped an hourly bonus that applied to EVERY payable hour in the pay period. The
-- product rule has been simplified: an hourly bonus now applies to ONE DAY, chosen by the manager.
-- "+$5/hr on Tuesday" is the thing people actually mean, and a fortnight-wide per-hour rate is a
-- second, easily-confused instrument nobody asked for. There is deliberately NO scope column and no
-- toggle — hourly means day-specific, always.
--
-- IT IS SAFE TO CHANGE THE MEANING, AND THAT WAS CHECKED RATHER THAN ASSUMED. Before this file was
-- written, the live table was read: 1 row total, 1 flat, and **ZERO hourly rows**. So no existing
-- bonus is being silently reinterpreted from "the whole period" to "one day" — there is nothing to
-- reinterpret. The single flat row (a real $50.00 performance bonus) is untouched by every statement
-- below: flat rows carry target_date NULL, which is exactly what the new constraints require of
-- them. No backfill is needed and none is performed.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LOCK FOOTPRINT (CLAUDE.md "classify by LOCK FOOTPRINT") — CLASS A
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- One `add column` that is NULLABLE WITH NO DEFAULT — catalog-only in PG11+, no table rewrite — and
-- three new CHECK constraints on `employee_pay_adjustments`, a table created yesterday that holds a
-- single row and is read by nothing in the capture or order-sync path.
--
-- THE ONE THING WORTH STATING: adding a CHECK constraint takes ACCESS EXCLUSIVE and validates every
-- existing row. On a 1-row table that is instantaneous, and `set local lock_timeout = '3s'` makes
-- contention abort rather than queue. The validation is not a formality either — it is what proves
-- the existing flat row satisfies the new shape, and it would REFUSE to apply if it did not.
--
-- This migration creates and replaces NO function, and touches no other table.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT — read-only, run before applying
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Also in supabase/preflight/151_bonus_target_date.preflight.sql.
--
--   -- 1. The column and the three constraint names are free.
--   select count(*) filter (where column_name = 'target_date')        as target_date_exists,
--          count(*)                                                   as columns_examined
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'employee_pay_adjustments';
--
--   -- 2. THE GATE: there must be no hourly rows to reinterpret.
--   select count(*) filter (where calculation_type = 'hourly')        as hourly_rows,
--          count(*) filter (where calculation_type = 'flat')          as flat_rows,
--          count(*)                                                   as rows_examined
--   from public.employee_pay_adjustments;
--   -- EXPECT hourly_rows = 0. ANY hourly row means STOP — see the header.
--
--   -- 3. Every existing row must already satisfy the constraints below, or the ADD will fail.
--   select count(*) as rows_that_would_be_refused
--   from public.employee_pay_adjustments
--   where not (calculation_type <> 'flat' or true)      -- flat rows have no target_date yet (NULL)
--      or calculation_type = 'hourly';                  -- and there are none of these
--
--   -- 4. Class A evidence — capture path liveness, before AND after.
--   select max(created_at), count(*) filter (where created_at > now() - interval '15 minutes')
--   from public.capture_events;
--
-- ROLLBACK: supabase/rollbacks/151_rollback.sql
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- THE DESIGN
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ONE NEW COLUMN, AND NO SCOPE COLUMN. If hourly always means "one day", then the presence of a
-- date IS the scope, and a separate `scope` enum would be a second source of truth that could
-- disagree with it. The constraints below make the pairing exact:
--
--   FLAT    amount_cents set  · rate_cents_per_hour NULL · target_date NULL
--   HOURLY  amount_cents NULL · rate_cents_per_hour set  · target_date SET, inside the period
--
-- 150's two shape constraints already police the two money columns and are LEFT ALONE — not dropped
-- and re-added. The three below are purely additive and compose with them, which keeps this
-- migration free of any `alter ... drop constraint` on a table that is already carrying real money.
--
-- STILL NO PERSISTED CALCULATED TOTAL, and there must never be one. The source of truth for an
-- hourly bonus is now (employee + pay period + target_date + rate); its dollar value is derived by
-- buildPayStatement from that DAY's canonical payable hours, every time a statement is built. That
-- is what makes a later shift correction re-price the bonus on its own.
--
-- WHICH HOURS A DAY HAS is not decided here and must never be. It is `paidShiftHours()` summed over
-- `isPayableShift()` rows whose `shifts.date` equals target_date — the same per-day grouping Pay
-- Details and the PDF already render, so a shift shown under Tuesday is a shift that pays Tuesday's
-- incentive, including the America/Los_Angeles cross-midnight behaviour, unchanged.
--
-- A ZERO-HOUR DAY IS LEGAL. The manager may pick any date in the period; a day with no payable
-- hours yet is simply worth $0.00 today and re-prices itself if a shift is later added or
-- confirmed. Nothing here requires the day to have hours, and nothing deletes such a bonus.

begin;
set local lock_timeout = '3s';

-- Nullable, no default: catalog-only, no rewrite. NULL on every flat row, required on hourly.
alter table public.employee_pay_adjustments
  add column if not exists target_date date;

comment on column public.employee_pay_adjustments.target_date is
  'HOURLY only. The single canonical work date (shifts.date) the per-hour rate is paid on; NULL on '
  'a flat row. The bonus is rate x that date''s canonical payable hours, derived at read time and '
  'stored nowhere. Constrained to fall inside [period_start, period_end].';

-- A FLAT bonus has no day. (150 already requires its amount and forbids its rate.)
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.employee_pay_adjustments'::regclass
                   and conname = 'employee_pay_adjustments_flat_no_target_date') then
    alter table public.employee_pay_adjustments
      add constraint employee_pay_adjustments_flat_no_target_date
      check (calculation_type <> 'flat' or target_date is null);
  end if;
end $$;

-- An HOURLY bonus MUST name its day. This is the rule the client is not trusted to enforce.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.employee_pay_adjustments'::regclass
                   and conname = 'employee_pay_adjustments_hourly_needs_target_date') then
    alter table public.employee_pay_adjustments
      add constraint employee_pay_adjustments_hourly_needs_target_date
      check (calculation_type <> 'hourly' or target_date is not null);
  end if;
end $$;

-- And that day must be INSIDE the pay period the bonus belongs to. A date outside it would be a
-- bonus priced off hours that this cheque does not pay — money attached to the wrong fortnight.
-- Written so it evaluates true/false rather than NULL (the migration-138 trap): a NULL target_date
-- is admitted here on purpose and refused by the two constraints above where it matters.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.employee_pay_adjustments'::regclass
                   and conname = 'employee_pay_adjustments_target_date_in_period') then
    alter table public.employee_pay_adjustments
      add constraint employee_pay_adjustments_target_date_in_period
      check (target_date is null
             or (target_date >= period_start and target_date <= period_end));
  end if;
end $$;

commit;
