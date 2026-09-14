-- 156_shift_capacity_blocks.sql
-- STAFFING CAPACITY → AUTOMATIC AVAILABLE SHIFTS.
-- Three new tables + one new RPC + one index on shift_instances.
--
-- ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-09-14. DO NOT RE-APPLY.                                        │
-- │ This DB has no migration ledger — this file IS the record that it ran.                       │
-- │                                                                                             │
-- │ Applied as its OWN 8 statement groups, byte-identical slices of this file in file order, so  │
-- │ each kept its `set local lock_timeout = '3s'` (the Management API wraps a single call in one │
-- │ transaction, which would have collapsed them).                                              │
-- │                                                                                             │
-- │ CLASS A RECIPE, all four parts reported:                                                     │
-- │  • md5(prosrc) of all 16 functions referencing shift_instances / shift_claims / employees,   │
-- │    before and after: 0 changed, 0 removed. Only the 3 new functions appeared.                │
-- │  • A LIVE SHOW WAS RUNNING (2 open host segments, capture idle 0 min). Nothing here touches  │
-- │    the capture path, and capture kept landing across the window: 73 capture_events in the    │
-- │    20 minutes spanning both migrations, still idle 0 min after.                              │
-- │  • Verified after apply: 3 tables, 11 indexes, RLS on all three, own-row policy on each,     │
-- │    lensed_approve_shift_request(uuid,uuid) SECURITY DEFINER, service_role=true and           │
-- │    authenticated/anon/public=false.                                                          │
-- │  • Live data unchanged: shift_instances 312, shift_claims 0, active employees 48. The three  │
-- │    capacity tables are EMPTY — no capacity is configured, so nothing is advertised.          │
-- └─────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- 🔢 PREFIX 156 was verified free across origin/main and every local + remote branch at authoring
--    time. 149 is already DOUBLE-CLAIMED (149_approved_minutes_live_host_only on main and a
--    FIFO 149 on a branch); 150–155 are taken (155_legacy_zero_cost_reconciliation lives on
--    feat/legacy-zero-cost-backfill). Do NOT backfill a lower gap — on a hand-applied DB a reused
--    prefix is a real skip / double-apply hazard, not a cosmetic one.
--    ⏱ APPLIED OUT OF NUMERIC ORDER, and that is fine: 158_show_auction_hosts landed on main and
--      was applied on 2026-09-13 while this branch was still in review, so production runs 158
--      BEFORE 156/157. Nothing here depends on 158 and nothing in 158 depends on this (it defines
--      one pnl_* function and touches no table). Noted so a future reader is not misled by the
--      numbers into thinking a migration was skipped. 155 is still unmerged
--      (feat/legacy-zero-cost-backfill) and remains free.
--
-- 🔒 LOCK FOOTPRINT (CLAUDE.md classification): CLASS A.
--    Three brand-new tables with their own indexes/policies/grants, one NEW function, and ONE new
--    index on the live public.shift_instances table (312 rows). The FKs take SHARE ROW EXCLUSIVE
--    briefly on auth.users / employees / shift_instances; the index build takes SHARE on
--    shift_instances. Every statement group runs in its OWN transaction with
--    `set local lock_timeout = '3s'`, so a contended lock ABORTS rather than queueing in front of
--    the capture path. CREATE INDEX is deliberately NOT concurrent: the Management API wraps
--    statements in a transaction and CONCURRENTLY fails there (see 079's header).
--
--    NOT exempt from Class B data-write gating: CLAUDE.md exempts only shift_rules,
--    shift_instances, shift_claims, employee_access_tokens and attendance_events, and says
--    extending that list needs explicit approval. These three tables are created EMPTY and this
--    migration backfills nothing, so the question does not arise — stated here so nobody assumes
--    an exemption that was never granted.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Management should not have to hand-create an open shift every time the floor has room for
-- another Live Host. The business knows how many host setups it can run at once; Lensed should
-- derive how many shifts remain AVAILABLE for a given block from that number minus who is already
-- scheduled across it.
--
-- Nothing in the schema can express "a shift slot that exists with ZERO employees assigned":
--   • shift_rules.employee_id is `not null` (047:25) — a rule is one PERSON's recurring schedule.
--   • shift_exceptions.rule_id points at that per-employee rule (047), so it inherits the problem.
--   • shift_templates — the one table that ever modeled "(weekday, start, end, role) + capacity"
--     (085:48-63) — was DROPPED by 086:90.
--
-- ⚠️ 086 REVERSED EXACTLY THIS SHAPE, so read it before judging this file. Its objection was the
--    template_id FAN-OUT: a template id written onto shift_instances, attendance_events and
--    shift_rules, which forked the schedule into two representations and made the instance's
--    identity depend on a template row. NONE of that returns here:
--      · shift_instances gets NO block_id column. Vacancies are DERIVED by interval overlap
--        against the times already denormalised on the row.
--      · shift_rules and attendance_events are not touched at all.
--      · A block is a STAFFING QUESTION ("how many at once?"), not a schedule representation.
--        Deleting every block on a Friday changes no one's schedule by a single row.
--    The 086 collapse therefore still holds: shift_rules remains the single schedule model.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- NO PLACEHOLDER ROWS — the load-bearing product rule
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Ten setups do NOT mean ten employee-less shift_instances. shift_instances keeps meaning exactly
-- what it means today: a real planned shift for a real person. A capacity vacancy is a COUNT
-- computed at read time, and a row appears only when a manager approves a request
-- (lensed_approve_shift_request below), with source='admin_open' — the value 090 already created
-- for "a manager put this shift here".
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A COWORKER-OFFERED SHIFT IS STILL STAFFED — guaranteed by 129's CHECK, not by convention
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The staffed-count predicate below has NO offer_state clause, deliberately. 129's
-- shift_instances_offered_is_owned CHECK makes offer_state='offered' imply employee_id IS NOT NULL
-- and status IN ('scheduled','claimed'), so an offered shift is counted by the ordinary predicate
-- and cannot free a setup. **Adding `offer_state <> 'offered'` here would be the bug**: it would
-- advertise an 11th spot while Carlos is still responsible for the 10th.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK: supabase/rollbacks/156_rollback.sql (drop the function, the three tables, the index).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 1. shift_capacity_blocks — the employee-independent staffing block.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

create extension if not exists "uuid-ossp";

create table if not exists public.shift_capacity_blocks (
  id uuid primary key default uuid_generate_v4(),
  -- The MANAGING account that owns the roster — same meaning as employees.user_id (044/047/085).
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The pay-role class this block staffs. Pinned to the two classes every other scheduling CHECK
  -- uses (085:60, 090:35) so a block can never name a team payroll does not recognise.
  team text not null,
  -- Optional manager-facing name ("Morning" / "Night"). Employees never see it.
  label text,
  -- getUTCDay() numbers, 0=Sun … 6=Sat — the SAME convention as shift_rules.days_of_week (047:26)
  -- and weekdayOf() in src/lib/schedule/timezone.ts. An empty array = the block never occurs.
  days_of_week smallint[] not null default '{}',
  -- LA wall clock (BUSINESS_TZ is a server-fixed constant, 085:28-30 — never a per-store column).
  -- end_time <= start_time means the block crosses midnight, the SAME rule crossesMidnight()
  -- (eligibility.ts) and instantsFor() (schedulePlan.ts) already encode for shifts.
  start_time time not null,
  end_time time not null,
  -- NULL = inherit the team default (shift_capacity_settings below), then the app constant.
  -- The "NULL means inherit, not zero" idiom is already this schema's — see
  -- shift_exceptions.modified_start / modified_end (047).
  capacity smallint,
  active boolean not null default true,
  store_id uuid,                              -- FK added below, guarded; never RLS-load-bearing
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_capacity_blocks_team_check check (team in ('host', 'fulfillment')),
  constraint shift_capacity_blocks_days_valid
    check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint shift_capacity_blocks_capacity_nonneg check (capacity is null or capacity >= 0),
  -- Equal times would be a ZERO-LENGTH block that crossesMidnight() (<=) would call overnight.
  -- adminShifts already refuses equal times for a shift; refuse them for a block too.
  constraint shift_capacity_blocks_times_differ check (start_time <> end_time)
);

create index if not exists idx_shift_capacity_blocks_owner_team
  on public.shift_capacity_blocks (user_id, team) where active;

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2. shift_capacity_settings — the TEAM DEFAULT and the per-DATE override, in ONE table.
--
--    Two shapes, and the CHECK admits nothing else:
--      (block_id IS NULL  AND date IS NULL)  → TEAM DEFAULT. "Live Host: 10 live setups."
--      (block_id NOT NULL AND date NOT NULL) → DATE OVERRIDE. "Wednesday night: 7", or closed.
--    A third scope (block default, block_id set + date null) is deliberately NOT admitted — a
--    block already carries its own `capacity` column, so that row would be a second way to say
--    the same thing.
--
--    Resolution order, implemented identically here and in src/lib/schedule/capacity.ts:
--        override.capacity ?? block.capacity ?? teamDefault.capacity ?? <app constant>
--
--    `closed` is separate from `capacity` on purpose: "stop taking requests" must not require
--    destroying the configured number, and must never touch a single assigned shift.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

create table if not exists public.shift_capacity_settings (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team text not null,
  block_id uuid references public.shift_capacity_blocks(id) on delete cascade,
  date date,
  capacity smallint,
  -- CLOSE AVAILABILITY. Stops NEW capacity requests for this scope. It cancels nothing, drops
  -- nothing, and mutates no assignment — see the RPC's AVAILABILITY_CLOSED refusal.
  closed boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_capacity_settings_team_check check (team in ('host', 'fulfillment')),
  constraint shift_capacity_settings_capacity_nonneg check (capacity is null or capacity >= 0),
  constraint shift_capacity_settings_shape check (
    (block_id is null and date is null) or (block_id is not null and date is not null)
  ),
  -- A team default that sets neither a number nor a closure is a row with no meaning.
  constraint shift_capacity_settings_team_default_is_meaningful check (
    block_id is not null or capacity is not null or closed
  )
);

-- One team default per (owner, team). Partial because block_id is nullable and Postgres treats
-- NULLs as DISTINCT — a plain UNIQUE(user_id, team, block_id, date) would not close this.
create unique index if not exists idx_shift_capacity_settings_team_default
  on public.shift_capacity_settings (user_id, team) where block_id is null;
-- One override per (block, date).
create unique index if not exists idx_shift_capacity_settings_block_date
  on public.shift_capacity_settings (block_id, date) where block_id is not null;
-- The manager outlook reads a date window for one owner.
create index if not exists idx_shift_capacity_settings_owner_date
  on public.shift_capacity_settings (user_id, date);

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 3. shift_requests — "Request Shift" against a DERIVED vacancy.
--
--    WHY NOT shift_claims. shift_claims.shift_instance_id is `uuid not null references
--    public.shift_instances(id)` (085:172). A capacity vacancy HAS no instance, and manufacturing
--    one is exactly what this feature must not do. Making that column nullable would also turn
--    BOTH of 129's race guards into no-ops for the new kind — idx_shift_claims_one_approved_pickup
--    and idx_shift_claims_one_pending_pickup_per_employee are keyed on shift_instance_id and NULLs
--    are distinct — silently removing the one-winner and double-tap guarantees from precisely the
--    rows that need them. shift_claims is therefore NOT TOUCHED by this migration.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

create table if not exists public.shift_requests (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  block_id uuid not null references public.shift_capacity_blocks(id) on delete cascade,
  shift_date date not null,
  -- DENORMALISED SPAN SNAPSHOT, for two reasons:
  --  (a) the manager queue must render a date and a time with no instance to hydrate from —
  --      the pickup queue's hydrate-or-blank path (adminShifts) is the failure mode to avoid;
  --  (b) ABA GUARD: if the block's times are edited after the request is filed, approval REFUSES
  --      (STALE_BLOCK) instead of quietly creating a different shift than the one requested.
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  team text not null,
  status text not null default 'pending',
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  -- Set on approval. ON DELETE SET NULL so the request trail outlives the shift it created.
  shift_instance_id uuid references public.shift_instances(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint shift_requests_status_check
    check (status in ('pending', 'approved', 'declined', 'withdrawn', 'superseded')),
  constraint shift_requests_team_check check (team in ('host', 'fulfillment')),
  constraint shift_requests_approved_has_instance
    check (status <> 'approved' or shift_instance_id is not null),
  constraint shift_requests_span_ordered check (ends_at > starts_at)
);

-- Manager queue.
create index if not exists idx_shift_requests_pending
  on public.shift_requests (user_id, shift_date) where status = 'pending';
-- The employee's own list, and the "Shift Requested" annotation on their board.
create index if not exists idx_shift_requests_employee
  on public.shift_requests (employee_id, shift_date);
-- THE DOUBLE-TAP GUARD, keyed on (employee, date) rather than (employee, block, date) on purpose:
-- shift_instances enforces UNIQUE(employee_id, shift_date) (086:69-70), so one person can hold at
-- most ONE shift per day. A second pending request for that day is un-approvable by construction,
-- so it must never reach the queue. Partial, so a declined request can be re-filed for that date.
create unique index if not exists idx_shift_requests_one_pending_per_day
  on public.shift_requests (employee_id, shift_date) where status = 'pending';

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Guarded store_id FK (the out-of-band `stores` table, same guard as 044:57-68 / 085).
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

do $$ begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'shift_capacity_blocks_store_id_fkey') then
      alter table public.shift_capacity_blocks
        add constraint shift_capacity_blocks_store_id_fkey
        foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 5. updated_at triggers (public.set_updated_at, defined in 021). Guarded for idempotency.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'set_updated_at') then
    if not exists (
      select 1 from pg_trigger where tgrelid = 'public.shift_capacity_blocks'::regclass
        and tgname = 'shift_capacity_blocks_set_updated_at' and not tgisinternal
    ) then
      create trigger shift_capacity_blocks_set_updated_at
        before update on public.shift_capacity_blocks
        for each row execute function public.set_updated_at();
    end if;
    if not exists (
      select 1 from pg_trigger where tgrelid = 'public.shift_capacity_settings'::regclass
        and tgname = 'shift_capacity_settings_set_updated_at' and not tgisinternal
    ) then
      create trigger shift_capacity_settings_set_updated_at
        before update on public.shift_capacity_settings
        for each row execute function public.set_updated_at();
    end if;
  end if;
end $$;

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 6. RLS + grants. Own-row RLS for the manager (admin) session; the employee-facing /s/[token]
--    routes go through the service-role client and scope by employee_id explicitly, exactly as
--    085:16-20 describes for every other scheduling table.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

alter table public.shift_capacity_blocks    enable row level security;
alter table public.shift_capacity_settings  enable row level security;
alter table public.shift_requests           enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'shift_capacity_blocks' and policyname = 'shift_capacity_blocks_own_rows') then
    create policy shift_capacity_blocks_own_rows on public.shift_capacity_blocks
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'shift_capacity_settings' and policyname = 'shift_capacity_settings_own_rows') then
    create policy shift_capacity_settings_own_rows on public.shift_capacity_settings
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'shift_requests' and policyname = 'shift_requests_own_rows') then
    create policy shift_requests_own_rows on public.shift_requests
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.shift_capacity_blocks   to authenticated;
grant select, insert, update, delete on public.shift_capacity_settings to authenticated;
grant select, insert, update, delete on public.shift_requests          to authenticated;
revoke all on public.shift_capacity_blocks   from anon;
revoke all on public.shift_capacity_settings from anon;
revoke all on public.shift_requests          from anon;

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 7. The index that makes the staffed-count overlap scan cheap.
--    ITS OWN TRANSACTION + lock_timeout: this is the one statement that touches a LIVE table.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

create index if not exists idx_shift_instances_owner_span
  on public.shift_instances (user_id, starts_at, ends_at);

commit;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 8. lensed_approve_shift_request — the ATOMIC approval.
--
-- The whole race-safety story lives here. Capacity is a COUNT invariant: no CHECK, no UNIQUE and
-- no EXCLUDE constraint can express "at most N rows overlap this window" (and btree_gist is not
-- installed on this database anyway). So the guarantee is an advisory lock + a recount inside it.
--
-- LOCK KEY = (owner, team, shift_date), NOT the block. Two blocks for one team on one date may
-- legitimately overlap in time (16:00–02:00 and 17:00–01:00 are both Live Host); a block-scoped
-- key would let two approvals into overlapping windows run concurrently and oversubscribe the
-- floor. Team+date serialises all of them, and contention is a handful of approvals per day.
--
-- WHY THIS DOES NOT USE THE EXISTING shift-scoped KEY. The three live scheduling RPCs all take
-- pg_advisory_xact_lock(hashtextextended(shift_instance_id::text, 0)). A capacity approval creates
-- a shift that has no id yet, so it cannot take that key — and does not need to, because all three
-- of those RPCs are COUNT-NEUTRAL: approve_shift_pickup moves an assignment A→B, approve_shift_trade
-- swaps two, cancel_shift_offer touches neither employee_id nor status nor released_at. None of
-- them can change staffed() for a block, so they cannot race this function's invariant.
--
-- RESIDUAL RACE, stated honestly rather than papered over: a manager bulk-scheduling through
-- applyScheduleBatch (plain PostgREST writes, not transactional) at the same instant as an approval
-- can still push a block over capacity. That is manager-vs-manager inside one account, and it is
-- not what this lock is for — concurrent APPROVALS are fully serialised.
--
-- WHY NO attendance_events ROW. A pickup writes a ('released' outgoing, 'claimed' incoming) pair
-- because a shift MOVED between two people. A capacity approval creates a brand-new shift: there
-- is no outgoing person, so a bare 'claimed' event would be unpaired — and drops are derived as
-- max(0, releases − claims), so writing one would silently FORGIVE an unrelated drop the employee
-- took earlier in the pay period. That is a money-adjacent side effect nobody asked for.
-- Do not "fix" this by adding one.
--
-- REFUSAL vs RAISE, the 129/130 discipline: every precondition returns {ok:false, reason} BEFORE
-- the first write, so the caller can map it to a manager-readable sentence. Everything after the
-- insert RAISES, so a late failure rolls the whole thing back rather than leaving a torn state.
--
-- CAPACITY IS EXPLICIT OR IT DOES NOT EXIST. There is deliberately no p_default_capacity argument
-- and no constant in this file: the chain ends at the owner's team default, and if that is unset
-- the block is NOT CONFIGURED and this function refuses with CAPACITY_NOT_CONFIGURED. An account
-- that never told Lensed how many setups it runs must not have shifts approved against a number
-- nobody chose. (The employee board publishes no opportunity for such a block either, so this
-- refusal is the server-side backstop rather than the common path.)
-- ───────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '3s';

create or replace function public.lensed_approve_shift_request(
  p_owner      uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_req        public.shift_requests;
  v_block      public.shift_capacity_blocks;
  v_ovr        public.shift_capacity_settings;
  v_team_def   public.shift_capacity_settings;
  v_emp        record;
  v_starts     timestamptz;
  v_ends       timestamptz;
  v_capacity   integer;
  v_closed     boolean;
  v_staffed    integer;
  v_today      date;
  v_new_id     uuid;
  v_superseded integer := 0;
begin
  if p_owner is null or p_request_id is null then
    raise exception 'INVALID_ARGS';
  end if;

  -- ── 1. Peek at the request, WITHOUT a row lock, only to learn which capacity lane it belongs to.
  --       Owner is a PREDICATE, never a trusted input.
  --
  --       LOCK ORDER IS DELIBERATE: advisory lock FIRST, row locks second, always. Taking
  --       `for update` on the request before the advisory lock would let two approvals hold each
  --       other's row while waiting for the same advisory key — a deadlock. This peek takes no
  --       lock, so nothing is held while the advisory lock is acquired.
  select * into v_req
    from public.shift_requests
   where id = p_request_id and user_id = p_owner;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_FOUND');
  end if;

  -- Serialise every approval for this owner + team + date.
  perform pg_advisory_xact_lock(
    hashtextextended('lensed_capacity:' || p_owner::text || ':' || v_req.team || ':' || v_req.shift_date::text, 0));

  -- Re-read AUTHORITATIVELY under the lock: the peek above is advisory only, and another approval
  -- may have decided this row while we waited for the key.
  select * into v_req
    from public.shift_requests
   where id = p_request_id and user_id = p_owner
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_FOUND');
  end if;

  if v_req.status <> 'pending' then
    -- Idempotent replay reports the terminal state instead of writing again.
    return jsonb_build_object(
      'ok', false,
      'reason', case when v_req.status = 'approved' then 'ALREADY_APPROVED' else 'REQUEST_NOT_PENDING' end,
      'request_status', v_req.status);
  end if;

  -- ── 2. The block. ──
  -- No FOR UPDATE here (nor on the two settings reads below): the advisory lock already
  -- serialises every approval in this owner+team+date lane, and row-locking the block or the team
  -- default would additionally serialise UNRELATED dates through one shared row. A manager editing
  -- a block mid-approval is caught by the ABA guard in step 3, not by a row lock.
  select * into v_block
    from public.shift_capacity_blocks
   where id = v_req.block_id and user_id = p_owner;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'BLOCK_NOT_FOUND');
  end if;
  if not v_block.active then
    return jsonb_build_object('ok', false, 'reason', 'BLOCK_INACTIVE');
  end if;
  if v_block.team is distinct from v_req.team then
    return jsonb_build_object('ok', false, 'reason', 'STALE_BLOCK');
  end if;
  -- extract(dow) is 0=Sun … 6=Sat — the same numbering as days_of_week and weekdayOf().
  if not (extract(dow from v_req.shift_date)::smallint = any (v_block.days_of_week)) then
    return jsonb_build_object('ok', false, 'reason', 'BLOCK_NOT_ON_DATE');
  end if;

  -- ── 3. ABA GUARD. Recompute the block's instants for this date and require them to still match
  --       the span the employee requested. `at time zone` resolves DST correctly and is the SQL
  --       twin of instantsFor() in src/lib/schedule/schedulePlan.ts.
  v_starts := (v_req.shift_date + v_block.start_time) at time zone 'America/Los_Angeles';
  v_ends := ((case when v_block.end_time <= v_block.start_time
                   then v_req.shift_date + 1 else v_req.shift_date end) + v_block.end_time)
            at time zone 'America/Los_Angeles';
  if v_starts <> v_req.starts_at or v_ends <> v_req.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'STALE_BLOCK');
  end if;

  -- ── 4. Capacity resolution + "close availability". ──
  select * into v_ovr
    from public.shift_capacity_settings
   where user_id = p_owner and block_id = v_block.id and date = v_req.shift_date;
  select * into v_team_def
    from public.shift_capacity_settings
   where user_id = p_owner and team = v_block.team and block_id is null;

  v_closed := coalesce(v_ovr.closed, false) or coalesce(v_team_def.closed, false);
  if v_closed then
    return jsonb_build_object('ok', false, 'reason', 'AVAILABILITY_CLOSED');
  end if;
  -- NO FINAL FALLBACK. null here means nobody has configured a capacity for this block.
  v_capacity := coalesce(v_ovr.capacity, v_block.capacity, v_team_def.capacity);
  if v_capacity is null then
    return jsonb_build_object('ok', false, 'reason', 'CAPACITY_NOT_CONFIGURED');
  end if;

  -- ── 5. The date must not already be in the past (LA business date). ──
  v_today := (now() at time zone 'America/Los_Angeles')::date;
  if v_req.shift_date < v_today then
    return jsonb_build_object('ok', false, 'reason', 'PAST_DATE');
  end if;

  -- ── 6. The employee must still be a real, ACTIVE employee of this owner, on this team. ──
  select e.id, e.store_id, e.status, e.role into v_emp
    from public.employees e
   where e.id = v_req.employee_id and e.user_id = p_owner;
  if not found or v_emp.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_UNAVAILABLE');
  end if;
  -- TEAM COMES FROM employees.role, NEVER shift_instances.role: every 'pattern' instance in
  -- production carries role IS NULL (it is derived from the assignee), so a role read off the
  -- instance would silently count nobody. employees.role is free text with no CHECK (044), so the
  -- trim+lower mapping is mandatory. Character-for-character equal to payrollTeamOfRole() in
  -- src/lib/employees.ts — pinned by src/lib/schedule/capacity.test.mjs.
  if (case
        when lower(btrim(coalesce(v_emp.role, ''))) in ('host', 'live host') then 'host'
        when lower(btrim(coalesce(v_emp.role, ''))) = 'fulfillment' then 'fulfillment'
        else 'other'
      end) <> v_block.team then
    return jsonb_build_object('ok', false, 'reason', 'WRONG_TEAM');
  end if;

  -- ── 7. THE ANTI-OVERSUBSCRIPTION RECOUNT. Under the lock, after every other refusal.
  --
  --    Half-open overlap [start, end): `si.starts_at < block_end and si.ends_at > block_start`.
  --    Touching endpoints do NOT overlap — the same product rule 131's overlap guard states
  --    ("06:00–10:00 followed by 10:00–14:00 is a legitimate split shift"). Written expanded
  --    rather than as tstzrange && so it needs no btree_gist and stays btree-indexable on
  --    idx_shift_instances_owner_span.
  --
  --    NO offer_state CLAUSE — see the header. An offered shift is still owned and still staffed.
  select count(*) into v_staffed
    from public.shift_instances si
    join public.employees e on e.id = si.employee_id
   where si.user_id = p_owner
     and e.user_id = p_owner
     and si.employee_id is not null
     and si.status in ('scheduled', 'claimed')
     and si.starts_at < v_ends
     and si.ends_at > v_starts
     and (case
            when lower(btrim(coalesce(e.role, ''))) in ('host', 'live host') then 'host'
            when lower(btrim(coalesce(e.role, ''))) = 'fulfillment' then 'fulfillment'
            else 'other'
          end) = v_block.team;

  if v_staffed >= v_capacity then
    return jsonb_build_object('ok', false, 'reason', 'NO_CAPACITY',
      'staffed', v_staffed, 'capacity', v_capacity);
  end if;

  -- ── 8. THE WRITE. source='admin_open' (090) — a manager put this shift here. shift_rule_id stays
  --       NULL so the forward materializer never regenerates or touches it.
  begin
    insert into public.shift_instances
      (user_id, employee_id, store_id, shift_date, starts_at, ends_at, status, source, role)
    values
      (p_owner, v_req.employee_id, v_emp.store_id, v_req.shift_date, v_starts, v_ends,
       'scheduled', 'admin_open', v_block.team)
    returning id into v_new_id;
  exception when unique_violation then
    -- UNIQUE(employee_id, shift_date) (086) — the employee picked up another shift that day
    -- between filing and approval. Safe to RETURN: the exception block rolled back the insert and
    -- nothing else has been written yet.
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_DOUBLE_BOOKED');
  end;

  -- ── ORDERING MATTERS FROM HERE DOWN. The shift exists; a `return` past this point would hand
  --    the caller a refusal while the insert stayed committed. Every failure below RAISES.
  update public.shift_requests
     set status = 'approved', decided_by = p_owner, decided_at = now(), shift_instance_id = v_new_id
   where id = p_request_id and user_id = p_owner and status = 'pending';
  if not found then
    raise exception 'REQUEST_VANISHED request=%', p_request_id;
  end if;

  -- Their other pending requests for the SAME DATE are now un-approvable (one shift per person per
  -- day). 'superseded', not 'declined': a manager did not refuse them, the world moved — the same
  -- honesty 129 chose for losing pickup rivals.
  update public.shift_requests
     set status = 'superseded', decided_at = now()
   where user_id = p_owner
     and employee_id = v_req.employee_id
     and shift_date = v_req.shift_date
     and status = 'pending'
     and id <> p_request_id;
  get diagnostics v_superseded = row_count;

  return jsonb_build_object(
    'ok', true,
    'shift_instance_id', v_new_id,
    'employee_id', v_req.employee_id,
    'shift_date', v_req.shift_date,
    'staffed_before', v_staffed,
    'capacity', v_capacity,
    'superseded', v_superseded
  );
end;
$body$;

-- Grants: service_role ONLY, matching every other lensed_* write RPC and CONVENTIONS.md. This
-- function takes p_owner as an argument and has no auth.uid() to trust, so granting `authenticated`
-- would let any signed-in user create a shift inside another tenant.
-- (Registered in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs.)
revoke execute on function public.lensed_approve_shift_request(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.lensed_approve_shift_request(uuid, uuid) to service_role;

commit;
