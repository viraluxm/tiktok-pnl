-- 150_employee_pay_adjustments.sql — BONUS / INCENTIVE PAY as its own payroll line item,
-- in two calculation types: a FLAT sum, or a RATE PER CANONICAL PAYABLE HOUR.
--
-- 📝 REVISED BEFORE FIRST APPLY (hourly bonuses added). This file has never run anywhere, so the
--    two calculation types are folded into it rather than chased with a 151 that would alter a
--    table nothing has ever created. There is no deployed schema to be compatible with, so the
--    columns below are the shape this table has always had as far as any database is concerned.
--    Prefix 150 re-verified free across origin/main, every local and remote branch and every
--    sibling worktree at the time of the revision.
--
-- ⛔ NOT APPLIED. As of writing this file has NOT been run against production. This DB has no
--    migration ledger (see CONVENTIONS.md) — the repo file is the only record, so when it IS
--    applied, that fact gets recorded HERE, in this header, the way 138/139/149 record theirs.
--
-- 🔢 PREFIX 150 was free across origin/main, every local and remote branch and every sibling
--    worktree at the time of writing (main's highest is 149_approved_minutes_live_host_only;
--    fix/rls-public-exposure claims a second 149; fix/fifo-cost-backfill-foundation claims
--    152-154). 150 and 151 were the only free prefixes below 152. Do NOT backfill a lower gap.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A manager owes someone $100 for a performance bonus. Today Lensed has nowhere to put it. Pay is
-- DERIVED — `sum(paid hours) * hourly_rate`, with no pay table anywhere (044's own words) — so the
-- only way to pay a bonus through the product was to inflate worked time or the hourly rate until
-- the total came out right. Both destroy the attendance record to move a payroll number, which is
-- the exact failure migration 139 was written to stop, and neither leaves any trace of WHY.
--
-- A bonus is therefore its own row, with its own money, attached to a PERSON and a PAY PERIOD and
-- to nothing else. It touches no shift, no punch, no rate and no approved duration.
--
-- AND A PER-HOUR INCENTIVE IS THE SAME PROBLEM, ONE STEP WORSE. "Everyone gets an extra $2 an hour
-- this fortnight" has, until now, only one expression in this product: raise `employees.hourly_rate`
-- and remember to put it back. That rewrites the person's actual wage, applies to every period from
-- then on, leaves nothing saying why, and is wrong the moment somebody forgets the second half. So
-- an hourly bonus is a row here too — a rate that is paid PER PAYABLE HOUR, sitting entirely beside
-- the base rate and changing nothing about it.
--
-- WHAT WAS AUDITED FIRST (2026-09-12, read-only, against the LIVE catalog — not the repo):
--   • No table anywhere in `public` matching bonus / adjust / incentive / payroll / reimburs.
--     (`order_payouts` is TikTok order settlement, not employee pay.)
--   • No COLUMN anywhere in `public` matching bonus / adjust / incentive / reimburs.
--   • `employees` carries exactly one rate (`hourly_rate numeric(10,2)`) and is `user_id`-scoped.
--   • `public.set_updated_at()` exists (migration 021) and is what the rest of the schema uses.
-- So there was no canonical model to extend, and this is the smallest addition that works.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LOCK FOOTPRINT (CLAUDE.md "classify by LOCK FOOTPRINT") — CLASS A
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- One brand-new table with a new name, its own indexes, its own policy, no function created or
-- replaced, and no existing table rewritten.
--
-- TWO THINGS IT DOES TOUCH, both on `employees`, and both stated rather than glossed:
--   1. `create unique index uq_employees_id_user on employees (id, user_id)` — an ordinary
--      (non-CONCURRENT) index build takes SHARE on `employees` and blocks WRITES to it for the
--      duration. `employees` is a roster table of a few dozen rows; the build is milliseconds, and
--      nothing in the capture or order-sync path writes it. `set local lock_timeout = '3s'` makes
--      contention ABORT rather than queue.
--   2. The composite FK below takes SHARE ROW EXCLUSIVE on `employees` briefly, per the Class A note
--      about foreign keys. Same lock_timeout, same reasoning.
-- `employees` is NOT a capture table and is not written mid-show. Apply each numbered section in
-- its OWN transaction with `set local lock_timeout = '3s'`.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT — run every one of these READ-ONLY queries and read the answers BEFORE applying
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Also in supabase/preflight/150_employee_pay_adjustments.preflight.sql, which prints them as one
-- labelled result set. Per CONVENTIONS.md every "nothing bad exists" check below reports the
-- cardinality of the set it examined, so a vacuous pass is visible.
--
--   -- 1. The name is free (table AND type AND index AND policy).
--   select not exists (select 1 from pg_class where relname = 'employee_pay_adjustments') as name_free,
--          (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as rows_examined;
--
--   -- 2. Nothing already claims these index names.
--   select count(*) filter (where relname = 'uq_employees_id_user')                as uq_exists,
--          count(*) filter (where relname = 'idx_epa_owner_period')                as idx1_exists,
--          count(*) filter (where relname = 'idx_epa_employee_period')             as idx2_exists,
--          count(*)                                                                as rows_examined
--   from pg_class where relkind = 'i';
--
--   -- 3. `employees` still looks the way this migration assumes (id uuid PK, user_id uuid NOT NULL).
--   select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'employees' and column_name in ('id','user_id');
--
--   -- 4. POSITIVE assertion (cannot pass vacuously): the trigger function this file attaches exists.
--   select proname, pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'set_updated_at';
--
--   -- 5. Class A evidence, per the deploy gate — capture path liveness, before AND after.
--   select max(created_at) as latest_capture_event,
--          count(*) filter (where created_at > now() - interval '15 minutes') as events_last_15m
--   from public.capture_events;
--   select max(last_seen_at) as latest_live_seen,
--          count(*) filter (where status = 'live') as sessions_marked_live
--   from public.live_sessions;
--
--   -- 6. md5 of every function body that references `employees`, before and after. Must be
--   --    byte-identical afterwards — this migration creates and replaces no function at all.
--   select p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prosrc like '%employees%' order by 1;
--
-- ROLLBACK: supabase/rollbacks/150_rollback.sql (drops the table; the bonus rows go with it).
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- THE DESIGN, AND THE FOUR THINGS THAT ARE LOAD-BEARING
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- 1. MONEY IS INTEGER CENTS, NEVER A FLOAT — in BOTH money columns. This is the repo's dominant
--    convention — ~30 migrations use `*_cents` (cost_cents, gmv_cents, expected_price_cents,
--    net_payout_cents …) and docs/viewtrack-integration.md states it outright: "integer cents
--    (USD)". $100.00 flat is 10000; $2.50 per hour is 250. The app sums in cents and divides once.
--
-- 1b. AN HOURLY BONUS STORES ITS RATE AND NEVER ITS RESULT. There is deliberately NO
--    `calculated_cents` column and there must never be one. The source of truth is
--    (employee + pay period + rate) and the answer is that rate multiplied by the employee's
--    canonical payable hours, worked out by buildPayStatement each time a statement is built.
--
--    WHY THAT IS THE WHOLE POINT: a manager fixes a forgotten clock-out and 72.50 payable hours
--    become 74.00. A derived incentive goes from $145.00 to $148.00 by itself, everywhere, at once.
--    A stored total would still say $145.00 — on the tile, in Pay Details, on the employee's
--    statement — and nothing anywhere would ever mention that it had gone stale. Payroll numbers
--    that silently stop tracking their inputs are the failure this schema is shaped to prevent.
--
--    The multiplicand is NOT redefined here either: it is `paidShiftHours()` summed over
--    `isPayableShift()` rows — the clocked span minus unpaid breaks for fulfillment, the approved
--    duration for a live host. One definition of an hour, the one payroll already pays.
--
-- 2. THE OWNER IS TAKEN FROM THE SESSION, NOT FROM THE CLIENT. `user_id` DEFAULTS to `auth.uid()`,
--    so the browser never sends an owner id at all, and RLS's WITH CHECK refuses one that is not
--    the caller's even if some future caller did send it. Two independent layers, neither trusting
--    the request body.
--
--    NOTE FOR ANY FUTURE SERVICE-ROLE CALLER: `auth.uid()` is NULL outside a user session, so an
--    admin-client insert that omits `user_id` fails the NOT NULL rather than writing an unowned
--    row. That is deliberate — a back-end writer must name the owner it means.
--
-- 3. A BONUS CANNOT CROSS A TENANT — enforced DECLARATIVELY, not by a trigger and not by the UI.
--    RLS alone is not enough: it constrains `user_id`, so a manager could otherwise write a row
--    owned by THEM that points at ANOTHER tenant's employee. The FK is therefore COMPOSITE —
--    (employee_id, user_id) → employees (id, user_id) — so Postgres itself refuses the pairing.
--    That is what `uq_employees_id_user` is for; `id` is already the primary key, so the index is
--    trivially unique and exists only to be a valid FK target.
--
-- 4. THE PERIOD MUST BE A REAL PAY PERIOD. A bonus written to an off-cycle window would be money
--    entered into the product that NO pay period ever displays again — a silent loss. The period
--    columns are therefore checked against the app's own cycle:
--
--        payPeriodFor(payday) = { end: payday − 5, start: end − 13 }   (src/lib/employees.ts)
--        PAY_ANCHOR = '2026-07-17' (a known payday Friday)
--        ⇒ payPeriodFor(PAY_ANCHOR) = { start: '2026-06-29', end: '2026-07-12' }
--        ⇒ every period start is 2026-06-29 + 14n, and every period is exactly 14 days.
--
--    ⚠️ '2026-06-29' BELOW IS DERIVED FROM PAY_ANCHOR AND IS PINNED TO IT BY TEST.
--       src/lib/pay/bonus.test.mjs reads THIS FILE, extracts the literal, and asserts it equals
--       payPeriodFor(PAY_ANCHOR).start computed by the real helper — and separately walks ±40 real
--       periods through the predicate. Changing PAY_ANCHOR therefore fails a test rather than
--       failing an INSERT in production. (Same cross-assertion pattern that keeps 139's SQL role
--       predicate honest.) If the anchor is ever moved, this constraint moves with it, in its own
--       migration, and any rows already written keep their own (still 14-day-aligned) window.
--
-- WHAT IS DELIBERATELY NOT HERE: deductions, taxes, reimbursements, commissions, benefits, net pay,
-- approval state, payment evidence, and any way to attach an incentive to ONE day or ONE shift — an
-- hourly bonus applies to every payable hour in its period, which needs no extra column and no
-- join. `kind` exists so the table has an honest name and a future category does not need a second
-- table, but its CHECK admits 'bonus' and nothing else today, so no unbuilt concept can be written
-- by accident. `calculation_type` is closed the same way. Lensed still records no evidence that
-- money moved.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — the FK target index on `employees`. Own transaction.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '3s';

-- Trivially unique (id is the PK); it exists solely so the composite FK in section 2 has a target.
create unique index if not exists uq_employees_id_user
  on public.employees (id, user_id);

comment on index public.uq_employees_id_user is
  'FK target for employee_pay_adjustments (employee_id, user_id). Trivially unique — id is already '
  'the primary key. Its only job is to let Postgres refuse a bonus row that pairs one tenant''s '
  'owner id with another tenant''s employee.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — the table. Own transaction.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '3s';

create extension if not exists "uuid-ossp";

create table if not exists public.employee_pay_adjustments (
  id uuid primary key default uuid_generate_v4(),

  -- THE OWNER, FROM THE SESSION. The client never sends this (see note 2 in the header).
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,

  employee_id uuid not null,

  -- The pay period this money belongs to, as the app's own canonical window. Inclusive, Mon→Sun.
  period_start date not null,
  period_end   date not null,

  -- 'bonus' and only 'bonus' today. See the header.
  kind text not null default 'bonus',

  -- HOW THIS LINE IS WORTH WHAT IT IS WORTH:
  --   'flat'    a fixed sum          → amount_cents set,         rate_cents_per_hour NULL
  --   'hourly'  a rate per hour      → rate_cents_per_hour set,  amount_cents NULL
  -- The pair of shape constraints below make those the only two rows that can exist.
  calculation_type text not null default 'flat',

  -- FLAT only. Integer cents, positive: this feature adds pay and never subtracts it.
  amount_cents integer,

  -- HOURLY only. Integer cents PER CANONICAL PAYABLE HOUR — $2.50/hr is 250. Multiplied by the
  -- employee's payable hours for this period at read time; the product is stored NOWHERE.
  rate_cents_per_hour integer,

  -- The manager's short reason ("Performance bonus"). Optional — the money is the fact; the
  -- sentence is a courtesy to whoever reads the statement in six months.
  description text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A bonus belongs to an employee OF THE SAME OWNER. Composite on purpose — see note 3.
  constraint employee_pay_adjustments_employee_fk
    foreign key (employee_id, user_id) references public.employees (id, user_id)
    on update cascade on delete cascade,

  constraint employee_pay_adjustments_kind_check
    check (kind = 'bonus'),
  constraint employee_pay_adjustments_calculation_type_check
    check (calculation_type in ('flat', 'hourly')),

  -- ── EXACTLY ONE OF THE TWO MONEY COLUMNS, PER TYPE ──────────────────────────────────────────
  -- Each type requires its own column to be present and positive AND the other to be NULL, so a
  -- half-flat/half-hourly row — or a row that is neither — cannot be written at all, and nothing
  -- downstream has to decide what one would mean.
  --
  -- `> 0`, not `>= 0`, in both: a zero-dollar bonus is a row that says nothing and still prints a
  -- line on somebody's statement.
  --
  -- These are written as `type <> X or (...)`, and every branch evaluates to a true/false rather
  -- than to NULL — `is not null` / `is null` are used rather than a bare comparison — because a
  -- CHECK that evaluates to NULL is treated as SATISFIED. That trap let a bad `shift_trades` row
  -- through a harness in migration 138; it does not get to happen twice.
  constraint employee_pay_adjustments_flat_shape
    check (calculation_type <> 'flat'
           or (amount_cents is not null and amount_cents > 0 and rate_cents_per_hour is null)),
  constraint employee_pay_adjustments_hourly_shape
    check (calculation_type <> 'hourly'
           or (rate_cents_per_hour is not null and rate_cents_per_hour > 0 and amount_cents is null)),

  -- Sanity ceilings, so a slipped keyboard cannot enter a number no payroll run could ever be.
  -- $1,000,000 flat.
  constraint employee_pay_adjustments_amount_sane
    check (amount_cents is null or amount_cents <= 100000000),
  -- $1,000.00 PER HOUR — far lower, because a rate is MULTIPLIED. Across a two-week period a person
  -- can be paid for roughly 336 hours, so this already allows a third of a million dollars of
  -- incentive; its real job is to stop a flat amount typed into the per-hour box.
  constraint employee_pay_adjustments_rate_sane
    check (rate_cents_per_hour is null or rate_cents_per_hour <= 100000),

  -- THE CANONICAL PAY PERIOD. See note 4 — the literal is pinned to PAY_ANCHOR by test.
  constraint employee_pay_adjustments_period_canonical
    check (period_end = period_start + 13
           and ((period_start - date '2026-06-29') % 14) = 0),

  -- Long enough for a real reason, short enough to stay one line on the statement and the PDF.
  constraint employee_pay_adjustments_description_len
    check (description is null or char_length(description) <= 120)
);

comment on table public.employee_pay_adjustments is
  'BONUS / INCENTIVE PAY. One row = one bonus line item owed to one employee for one pay period, '
  'either a FLAT sum (amount_cents) or a RATE PER CANONICAL PAYABLE HOUR (rate_cents_per_hour). '
  'Separate from worked time by construction: it references no shift, creates no hours, and changes '
  'no rate or approved duration. An hourly line stores its RATE only — its dollar value is derived '
  'from the period''s payable hours every time a statement is built, so correcting a punch re-prices '
  'it automatically. Never add a calculated-total column. Total owed = worked pay + sum(bonus lines).';

comment on column public.employee_pay_adjustments.user_id is
  'Owner (tenant). Defaults to auth.uid() so the client never supplies it; RLS refuses any other value.';
comment on column public.employee_pay_adjustments.calculation_type is
  'flat = a fixed amount_cents; hourly = rate_cents_per_hour x the employee''s canonical payable '
  'hours for this period. Not editable in the UI — changing type is delete-and-re-add.';
comment on column public.employee_pay_adjustments.amount_cents is
  'FLAT only. Integer cents, strictly positive; NULL on an hourly row. Never a float.';
comment on column public.employee_pay_adjustments.rate_cents_per_hour is
  'HOURLY only. Integer cents per canonical payable hour; NULL on a flat row. The dollar value is '
  'DERIVED at read time and deliberately stored nowhere.';
comment on column public.employee_pay_adjustments.period_start is
  'Canonical pay-period Monday, per payPeriodFor() in src/lib/employees.ts. CHECK-constrained to the cycle.';

-- The Pay tab reads one period for the whole roster; Pay Details reads one person's.
create index if not exists idx_epa_owner_period
  on public.employee_pay_adjustments (user_id, period_start);
create index if not exists idx_epa_employee_period
  on public.employee_pay_adjustments (employee_id, period_start);

-- updated_at, via the trigger function the rest of the schema uses (migration 021).
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.employee_pay_adjustments'::regclass
      and tgname = 'employee_pay_adjustments_set_updated_at'
      and not tgisinternal
  ) then
    create trigger employee_pay_adjustments_set_updated_at
      before update on public.employee_pay_adjustments
      for each row execute function public.set_updated_at();
  end if;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — RLS + grants. Own transaction.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Own-row, all four verbs, the same idiom as employees / shifts / shift_trades. This is payroll
-- data written straight from the manager's session through PostgREST, so the policy IS the
-- server-side authorization — there is no route in front of it to trust instead.
--
-- There is deliberately NO anon policy and NO service-role path: the employee-facing /s/* portal
-- does not read or write this table. If it ever shows bonuses, that is a separate, reviewed change.
begin;
set local lock_timeout = '3s';

alter table public.employee_pay_adjustments enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_pay_adjustments'
      and policyname = 'employee_pay_adjustments_own_rows'
  ) then
    create policy employee_pay_adjustments_own_rows
      on public.employee_pay_adjustments
      for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Explicit, even though Supabase's default privileges normally cover a new public table: three
-- production incidents in this repo trace to "the object existed but the caller could not use it"
-- (CONVENTIONS.md). A redundant grant costs nothing; a missing one is a silent 401 on a button.
grant select, insert, update, delete on public.employee_pay_adjustments to authenticated;
revoke all on public.employee_pay_adjustments from anon;

commit;
