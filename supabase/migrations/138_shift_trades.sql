-- 138_shift_trades.sql — one-for-one SHIFT TRADES between two employees (employee portal v1).
--
-- ✅ APPLIED TO PRODUCTION 2026-09-09 04:00 UTC. This DB has NO migration ledger — migrations are
--    applied BY HAND and the repo file is the only record (see CONVENTIONS.md), so this line IS the
--    record. DO NOT APPLY IT AGAIN: `shift_trades`, its indexes, its policy and
--    `lensed_approve_shift_trade` all exist in production already. Re-applying is harmless (every
--    statement is `if not exists` / `create or replace`) but pointless.
--
-- 🔢 RENUMBERED 136 → 138, BOOKKEEPING ONLY. It was applied as `136_shift_trades.sql`, and while it
--    sat unmerged, PR #231 landed its own 136 and 137 on main. Two files per prefix in a repo whose
--    filenames ARE the ledger is a real double-apply hazard, so this one moved to the next free
--    prefix. Not one byte of executable SQL changed in the move — only these comments. Prefixes 138
--    and 139 were free across origin/main, every local and remote branch, and every sibling
--    worktree when the rename was made. Do NOT backfill a lower gap.
--
-- LOCK FOOTPRINT (CLAUDE.md "classify by LOCK FOOTPRINT"): CLASS A. One brand-new table, its own
-- indexes and policy, and one NEW function. It rewrites no existing table and replaces no live
-- function. The three foreign keys take SHARE ROW EXCLUSIVE briefly on the REFERENCED tables
-- (employees, shift_instances, auth.users) — apply each statement group in its own transaction with
-- `set local lock_timeout = '3s'` per the Class A recipe. shift_instances is a scheduling table
-- (exempt from Class B data gating; nothing reads it during a live show).
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The Phase 2 offer lifecycle (129/130) moves ONE shift from one person to another with a manager's
-- approval. A trade is a different shape: TWO shifts change hands at once, and the coworker must
-- agree before the manager ever sees it. Forcing that into shift_claims would mean two coupled
-- pickup rows whose approval must be simultaneous, which PostgREST cannot express and which would
-- leave exactly the half-state a swap must never show (one shift moved, the other not). So a trade
-- is its own row with its own state machine, and the ownership change is ONE transactional RPC.
--
-- STATE MACHINE (status):
--   pending_coworker  the requester proposed it; the coworker has not answered
--   pending_manager   the coworker accepted; a manager decides
--   approved          the RPC swapped the two assignments (terminal)
--   declined          the coworker said no (coworker_response='declined') OR the manager did
--                     (decided_by set) — the two are distinguishable by which columns are set
--   cancelled         the requester withdrew before approval (terminal)
--
-- NOTHING MOVES until `approved`. The employee-facing routes only ever INSERT a pending_coworker row
-- or flip status with a compare-and-swap; the ONLY writer of shift_instances in this file is the
-- approval RPC below.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- HOW THE SWAP INTERACTS WITH THE EXISTING SCHEMA (each point verified against the live catalog)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- • UNIQUE (employee_id, shift_date) on shift_instances (086). A same-day swap (my AM for your PM)
--   is legal and common, but a single UPDATE that swaps two employee_ids can trip a NON-DEFERRABLE
--   unique index mid-statement. The RPC therefore swaps in three steps inside one exception block:
--   A → NULL, B → requester, A → target. A genuine collision (the target already works my day)
--   surfaces as unique_violation and is returned as EMPLOYEE_DOUBLE_BOOKED with the block rolled
--   back — nothing else has been written at that point.
-- • The forward materializer's REGENERATION GUARD (materializeForward.ts) skips (employee_id,
--   shift_date) when an unresolved 'released' attendance_events row exists. After a swap the
--   requester has NO instance on their old date, so without a 'released' row the next daily run
--   would regenerate their pattern shift there and quietly undo the trade. The RPC writes the same
--   ('released' outgoing, 'claimed' incoming) pair 130's pickup approval writes — for BOTH sides —
--   so each person nets to zero drops (drops = max(0, releases − claims) per employee, drops.ts)
--   and neither old slot can regenerate.
-- • reconcile.ts expects every status='claimed', source='claim' instance to have a 'claimed'
--   event. The swapped rows are stamped exactly like a pickup transfer (status 'claimed', source
--   'claim', released_at NULL) and both receive a 'claimed' event, so the sweep stays green.
-- • shift_instances_offered_is_owned: an OFFERED shift may not be traded (the RPC refuses
--   SHIFT_OFFERED; offer.ts refuses offering a shift in an active trade), so the two transfer
--   mechanisms never hold the same shift at once.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE. Nothing existing is altered, so this MAY BE APPLIED BEFORE
-- THE CODE DEPLOY: until the new bundle ships, nothing calls the RPC and nothing reads the table.
--
-- ROLLBACK. The APP can be rolled back with this migration in place — the old bundle has no trade
-- surface and simply ignores both objects. Reverting the SCHEMA is only for abandoning the feature:
--     drop function if exists public.lensed_approve_shift_trade(uuid, uuid, date);
--     drop table if exists public.shift_trades;          -- DESTROYS the trade history
-- Note the asymmetry: dropping the table loses who traded what, but an approved trade has ALREADY
-- moved the two assignments in shift_instances and those stay moved. That is correct (the people
-- worked the shifts they swapped into) but it means the drop is not an undo. Capture the history
-- first if any trade has been approved:
--     select * from public.shift_trades order by created_at;

begin;

-- Fail fast rather than queue. The foreign keys below take SHARE ROW EXCLUSIVE on employees,
-- shift_instances and auth.users; if any is mid-write the CREATE TABLE would wait and readers
-- would pile up behind it. 3s per the Class A recipe: on a timeout nothing is applied, and it is
-- safe to retry.
set local lock_timeout = '3s';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.shift_trades (
  id uuid primary key default gen_random_uuid(),
  -- The MANAGING account that owns the roster (same meaning as employees.user_id).
  user_id uuid not null references auth.users(id) on delete cascade,
  requester_employee_id       uuid not null references public.employees(id) on delete cascade,
  requester_shift_instance_id uuid not null references public.shift_instances(id) on delete cascade,
  target_employee_id          uuid not null references public.employees(id) on delete cascade,
  target_shift_instance_id    uuid not null references public.shift_instances(id) on delete cascade,
  status text not null default 'pending_coworker',
  -- Coworker's answer. Set together with coworker_responded_at by the /respond route (CAS).
  coworker_response text,
  coworker_responded_at timestamptz,
  -- Manager decision trail. decided_by is an auth.users id (the manager), NOT an employees id.
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_trades_status_check
    check (status in ('pending_coworker', 'pending_manager', 'approved', 'declined', 'cancelled')),
  constraint shift_trades_response_check
    check (coworker_response is null or coworker_response in ('accepted', 'declined')),
  constraint shift_trades_two_people   check (requester_employee_id <> target_employee_id),
  constraint shift_trades_two_shifts   check (requester_shift_instance_id <> target_shift_instance_id),
  -- pending_manager means the coworker ACCEPTED; a coworker decline is terminal ('declined').
  -- coalesce, because a CHECK that evaluates to NULL is treated as satisfied: without it a
  -- pending_manager row with NO response at all would slip through (caught by the harness).
  constraint shift_trades_manager_stage_has_acceptance
    check (status <> 'pending_manager' or coalesce(coworker_response, '') = 'accepted'),
  -- An approval always records who and when.
  constraint shift_trades_approved_is_decided
    check (status <> 'approved' or (decided_by is not null and decided_at is not null))
);

comment on table public.shift_trades is
  'One-for-one shift trade proposals between two employees of one owner. NOTHING moves until status=approved, '
  'which only lensed_approve_shift_trade may set — it re-validates both shifts and swaps the assignments atomically.';

-- One LIVE trade per shift, per side. The two partial unique indexes stop a double-tap and the
-- "same shift proposed to two people" case. A shift being the REQUESTER side of one trade and the
-- TARGET side of another is not expressible as a unique index across two columns; the application
-- pre-check refuses it and the approval RPC refuses it again (CONFLICTING_TRADE), so at worst two
-- pending rows coexist and one is refused at decision time.
create unique index if not exists idx_shift_trades_live_requester_shift
  on public.shift_trades (requester_shift_instance_id)
  where status in ('pending_coworker', 'pending_manager');
create unique index if not exists idx_shift_trades_live_target_shift
  on public.shift_trades (target_shift_instance_id)
  where status in ('pending_coworker', 'pending_manager');

-- The manager queue and each employee's own list.
create index if not exists idx_shift_trades_owner_status on public.shift_trades (user_id, status, created_at);
create index if not exists idx_shift_trades_requester on public.shift_trades (requester_employee_id, created_at);
create index if not exists idx_shift_trades_target    on public.shift_trades (target_employee_id, created_at);

-- updated_at, same trigger fn the rest of the schema uses (migration 021's set_updated_at).
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.shift_trades'::regclass and tgname = 'shift_trades_set_updated_at' and not tgisinternal
  ) then
    create trigger shift_trades_set_updated_at
      before update on public.shift_trades
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Own-row RLS for any future session-client read (the manager's own account). The public /s/*
-- token routes write via the service-role client, which bypasses RLS and is scoped explicitly by
-- the token-resolved employee in every query — the token plus that filter is the boundary there.
alter table public.shift_trades enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'shift_trades' and policyname = 'shift_trades_own_rows'
  ) then
    create policy shift_trades_own_rows on public.shift_trades
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE APPROVAL — the only thing that ever swaps ownership
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER + service_role only, matching lensed_approve_shift_pickup. The API layer performs
-- the admin/session authorization and passes the owner explicitly; this function's job is the CAS
-- and the atomic multi-row write. Every precondition is re-read under FOR UPDATE, so a row that
-- changed since the manager loaded the queue fails cleanly instead of moving the wrong shift.
--
-- Refusals return {ok:false, reason} so the caller can show a sentence; only genuine faults raise.
-- Past the swap, every failure RAISES so the whole transfer rolls back (the 129 torn-state lesson).
create or replace function public.lensed_approve_shift_trade(
  p_owner            uuid,
  p_trade_id         uuid,
  p_pay_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_t   public.shift_trades;
  v_a   public.shift_instances;   -- requester's shift (goes to the target)
  v_b   public.shift_instances;   -- target's shift (goes to the requester)
  v_req public.employees;
  v_tgt public.employees;
  v_conflicts int;
begin
  if p_owner is null then raise exception 'INVALID_OWNER'; end if;
  if p_pay_period_start is null then raise exception 'INVALID_PAY_PERIOD'; end if;

  -- ── Lock and validate the trade. ──
  select * into v_t from public.shift_trades where id = p_trade_id and user_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'TRADE_NOT_FOUND'); end if;
  if v_t.status <> 'pending_manager' then
    return jsonb_build_object('ok', false, 'reason',
      case when v_t.status = 'approved' then 'ALREADY_APPROVED' else 'TRADE_NOT_PENDING' end,
      'status', v_t.status);
  end if;

  -- Serialize with every other transfer on either shift: SAME advisory key scheme as
  -- lensed_approve_shift_pickup / lensed_cancel_shift_offer, taken in a fixed order so two trades
  -- touching the same pair cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended(least(v_t.requester_shift_instance_id, v_t.target_shift_instance_id)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(v_t.requester_shift_instance_id, v_t.target_shift_instance_id)::text, 0));

  -- ── Lock and validate both shifts. Owner scope is a predicate, never an assumption. ──
  select * into v_a from public.shift_instances where id = v_t.requester_shift_instance_id and user_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_FOUND', 'side', 'requester'); end if;
  select * into v_b from public.shift_instances where id = v_t.target_shift_instance_id and user_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_FOUND', 'side', 'target'); end if;

  if v_a.employee_id is distinct from v_t.requester_employee_id then
    return jsonb_build_object('ok', false, 'reason', 'REQUESTER_NO_LONGER_OWNS');
  end if;
  if v_b.employee_id is distinct from v_t.target_employee_id then
    return jsonb_build_object('ok', false, 'reason', 'TARGET_NO_LONGER_OWNS');
  end if;
  if v_a.status not in ('scheduled', 'claimed') or v_b.status not in ('scheduled', 'claimed') then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_ACTIVE');
  end if;
  if v_a.released_at is not null or v_b.released_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_RELEASED');
  end if;
  if v_a.offer_state = 'offered' or v_b.offer_state = 'offered' then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_OFFERED');
  end if;
  if v_a.starts_at <= now() or v_b.starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_STARTED');
  end if;

  -- ── Both people must still be real, active employees of this owner, in the same role. ──
  select * into v_req from public.employees where id = v_t.requester_employee_id and user_id = p_owner and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_UNAVAILABLE', 'side', 'requester'); end if;
  select * into v_tgt from public.employees where id = v_t.target_employee_id and user_id = p_owner and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_UNAVAILABLE', 'side', 'target'); end if;
  if v_req.role is null or v_req.role is distinct from v_tgt.role
     or coalesce(v_a.role, v_req.role) is distinct from v_tgt.role
     or coalesce(v_b.role, v_tgt.role) is distinct from v_req.role then
    return jsonb_build_object('ok', false, 'reason', 'ROLE_MISMATCH');
  end if;

  -- ── No OTHER live trade may involve either shift (the cross-column case the indexes cannot see). ──
  select count(*) into v_conflicts from public.shift_trades
   where user_id = p_owner and id <> p_trade_id
     and status in ('pending_coworker', 'pending_manager')
     and (requester_shift_instance_id in (v_a.id, v_b.id) or target_shift_instance_id in (v_a.id, v_b.id));
  if v_conflicts > 0 then
    return jsonb_build_object('ok', false, 'reason', 'CONFLICTING_TRADE', 'conflicts', v_conflicts);
  end if;

  -- ── THE SWAP. Three steps in one exception block so UNIQUE(employee_id, shift_date) cannot fire
  --    mid-swap on a same-day trade, and so a genuine collision rolls all three back together. ──
  begin
    update public.shift_instances set employee_id = null where id = v_a.id;
    update public.shift_instances
       set employee_id = v_req.id, status = 'claimed', source = 'claim', released_at = null
     where id = v_b.id and user_id = p_owner and employee_id = v_tgt.id;
    if not found then raise exception 'TRADE_SWAP_B_VANISHED trade=% shift=%', p_trade_id, v_b.id; end if;
    update public.shift_instances
       set employee_id = v_tgt.id, status = 'claimed', source = 'claim', released_at = null
     where id = v_a.id and user_id = p_owner and employee_id is null;
    if not found then raise exception 'TRADE_SWAP_A_VANISHED trade=% shift=%', p_trade_id, v_a.id; end if;
  exception when unique_violation then
    -- The block's own subtransaction is rolled back; nothing else has been written yet, so a
    -- refusal here cannot tear anything.
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_DOUBLE_BOOKED');
  end;

  -- ── RAISE-DON'T-RETURN ZONE. The assignments have moved; any failure below must abort everything. ──
  update public.shift_trades
     set status = 'approved', decided_by = p_owner, decided_at = now()
   where id = p_trade_id and status = 'pending_manager';
  if not found then raise exception 'TRADE_VANISHED trade=%', p_trade_id; end if;

  -- Attendance pair for EACH side (see the header): the outgoing person is charged a release, the
  -- incoming person is credited a claim. Each nets to zero; each old slot is guarded from
  -- regeneration by its 'released' row.
  insert into public.attendance_events
    (user_id, employee_id, shift_instance_id, shift_date, event_type, pay_period_start)
  values
    (p_owner, v_req.id, v_a.id, v_a.shift_date, 'released', p_pay_period_start),
    (p_owner, v_tgt.id, v_a.id, v_a.shift_date, 'claimed',  p_pay_period_start),
    (p_owner, v_tgt.id, v_b.id, v_b.shift_date, 'released', p_pay_period_start),
    (p_owner, v_req.id, v_b.id, v_b.shift_date, 'claimed',  p_pay_period_start);

  return jsonb_build_object(
    'ok', true,
    'trade_id', p_trade_id,
    'requester_employee_id', v_req.id,
    'target_employee_id', v_tgt.id,
    'requester_now_has', v_b.id,
    'target_now_has', v_a.id,
    'attendance_events', 4
  );
end;
$body$;

-- Grants: service_role ONLY, matching every other lensed_* write RPC. The admin route resolves the
-- owner from the session and calls this with the admin client; never anon, never authenticated.
-- (Registered in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs.)
revoke execute on function public.lensed_approve_shift_trade(uuid, uuid, date) from public, anon, authenticated;
grant  execute on function public.lensed_approve_shift_trade(uuid, uuid, date) to service_role;

commit;
