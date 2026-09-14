-- 157_schedule_capacity_write_guard.sql
-- CLOSE THE LAST CAPACITY RACE: make the manager scheduling WRITE paths capacity-aware, under the
-- same lock 156's approval already takes.
--
-- ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
-- │ APPLIED TO PRODUCTION: 2026-09-14, immediately after 156. DO NOT RE-APPLY.                  │
-- │ This DB has no migration ledger — this file IS the record that it ran.                       │
-- │                                                                                             │
-- │ Function bodies only: no table, no column, no data, no capture-path lock. Verified after     │
-- │ apply: lensed_apply_schedule_batch(uuid,jsonb,uuid[],uuid[]) and                             │
-- │ lensed_assign_released_shift(uuid,uuid,uuid), both SECURITY DEFINER, search_path=public,     │
-- │ service_role=true and authenticated/anon=false. NO pre-existing function was replaced or     │
-- │ narrowed (md5(prosrc) identical across all 16, see 156's box), and neither name collides     │
-- │ with a live function, so no ambiguous overload was created.                                  │
-- │                                                                                             │
-- │ ORDER: 156 first, always. This file references public.shift_capacity_blocks and              │
-- │ public.shift_capacity_settings and will not apply without them.                              │
-- └─────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- 🔢 PREFIX 157: verified free across origin/main and every local + remote ref. 156 is this
--    branch's own. Do NOT backfill a lower gap.
--    ⏱ Production applies 158 (merged and applied 2026-09-13) BEFORE 156/157 — see 156's header.
--      Order within THIS pair is what matters: 156 first, then 157.
--
-- 🔒 LOCK FOOTPRINT (CLAUDE.md): CLASS A. Two NEW functions. No table is created, altered, dropped
--    or backfilled — the catalog delta is two pg_proc rows and their grants. Wrapped with
--    `set local lock_timeout = '3s'` like every other statement group in this branch.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 156 made APPROVING a shift request race-safe: an advisory lock on (owner, team, date) plus a
-- recount inside it, so two managers approving the last shift produce one assignment and one
-- refusal. That closed one door and left another open, which 156's own header admitted:
--
--     "a manager bulk-scheduling through applyScheduleBatch (plain PostgREST writes, not
--      transactional) at the same instant as an approval can still push a block over capacity."
--
-- The reason is structural, not a missing check. applyScheduleBatch computes its plan, then issues
-- an upsert, a delete and an update as THREE separate PostgREST statements. A capacity check in
-- TypeScript before those statements is a check-then-act across three transactions: by the time the
-- upsert lands, an approval in another connection may have taken the last shift. No amount of
-- re-reading in the app layer fixes that; the count and the write have to be in one transaction
-- that holds the lane lock.
--
-- So the write moves into SQL. That is also what bulkSchedule.ts's own header said the fix would
-- be — "A DB function would make this a single transaction; that is a later migration" — so this
-- migration additionally closes the torn-write window it documented, where a failure between the
-- upsert and the delete could leave a requested-off day still scheduled.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ONE ALGORITHM, NOT TWO
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Every capacity decision below is the SAME one 156 makes, character for character:
--   • effective capacity   coalesce(date override, block, team default) — and NULL means NOT
--                          CONFIGURED, which imposes no limit here and publishes nothing there
--   • the staffed count    employee_id NOT NULL, status in ('scheduled','claimed'), team from
--                          employees.role (never shift_instances.role), half-open interval overlap
--   • the lane lock        pg_advisory_xact_lock on 'lensed_capacity:<owner>:<team>:<date>'
-- There is deliberately NO offer_state clause: a dropped shift is still owned and still staffed.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT IS AND IS NOT GATED
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- GATED: a proposed row that would NEWLY occupy a setup inside an active capacity block.
--
-- NOT GATED, on purpose:
--   • Any row on a team/date/span with no active capacity block. It takes no lock at all, so a
--     fulfillment week and a host week never wait on each other, and an account with no blocks
--     configured behaves exactly as it does today.
--   • A block whose capacity is NOT CONFIGURED. No number exists, so there is no ceiling; the team
--     schedules exactly as it did before this migration, and employees are offered nothing.
--   • Removals. They only ever lower the count.
--   • A row that ALREADY occupies that block. Editing the time of someone inside a block, or
--     re-saving them unchanged, is not an addition. This is what makes "10 / 8 scheduled, over
--     capacity by 2" survivable: management lowered the number, and the ten people who are already
--     on the schedule stay on it and can still be edited and moved. Only the ELEVENTH is refused.
--   • `closed`. Closing availability stops new capacity REQUESTS from employees; it has never
--     meant a manager cannot schedule someone directly, and 156's UI copy says so in as many
--     words. A manager writing a shift into a closed day is deliberate, not a race.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK: supabase/rollbacks/157_rollback.sql (drop the two functions). The app falls back to
-- its pre-157 statement sequence automatically when the function is absent — see bulkSchedule.ts.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '3s';

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- lensed_apply_schedule_batch — the whole bulk write, in one transaction, capacity-aware.
--
-- p_upserts is the planner's `upserts` array verbatim (src/lib/schedule/schedulePlan.ts, UpsertRow),
-- so the SQL never re-derives what the planner already decided. Everything the planner refuses is
-- refused before this function is called and never reaches it; this function adds exactly one new
-- refusal code, OVER_CAPACITY, which the planner cannot compute because it has no lock.
--
-- NO DEFAULT-CAPACITY ARGUMENT, matching 156. A block whose capacity chain resolves to NULL is
-- NOT CONFIGURED, and an unconfigured block imposes NO LIMIT on a manager's own write: scheduling
-- must behave for such a team exactly as it does today. (It publishes nothing to employees either,
-- so there is no availability to protect.) The gate applies only where a number actually exists.
--
-- PARTIAL APPLICATION IS THE POINT. A week save that is fine on six days and full on the seventh
-- writes the six and names the seventh. Planner refusals stay all-or-nothing (nothing is written
-- and the caller never reaches here); capacity refusals are per-row.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.lensed_apply_schedule_batch(
  p_owner      uuid,
  p_upserts    jsonb,
  p_delete_ids uuid[],
  p_cancel_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  u              record;
  blk            record;
  v_team         text;
  v_lanes        text[] := '{}';
  v_lane         text;
  v_refusals     jsonb := '[]'::jsonb;
  v_created      int := 0;
  v_updated      int := 0;
  v_removed      int := 0;
  v_n            int;
  v_staffed      int;
  v_capacity     int;
  v_already      boolean;
  v_blocked      jsonb;
  v_existing_id  uuid;
begin
  if p_owner is null then raise exception 'INVALID_OWNER'; end if;

  -- ── 1. Which lanes does this batch touch? A lane is (owner, team, date) and exists only when an
  --       ACTIVE block for that team runs on that date AND the proposed span overlaps its window.
  --       Collected first, so the locks can be taken in a deterministic order.
  for u in
    select x.employee_id, x.shift_date, x.starts_at, x.ends_at,
           (case
              when lower(btrim(coalesce(e.role, ''))) in ('host', 'live host') then 'host'
              when lower(btrim(coalesce(e.role, ''))) = 'fulfillment' then 'fulfillment'
              else 'other'
            end) as team
      from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb))
           as x(employee_id uuid, shift_date date, starts_at timestamptz, ends_at timestamptz)
      join public.employees e on e.id = x.employee_id and e.user_id = p_owner
  loop
    if exists (
      select 1 from public.shift_capacity_blocks b
       where b.user_id = p_owner and b.active and b.team = u.team
         and extract(dow from u.shift_date)::smallint = any (b.days_of_week)
         and u.starts_at < (((case when b.end_time <= b.start_time then u.shift_date + 1 else u.shift_date end) + b.end_time) at time zone 'America/Los_Angeles')
         and u.ends_at   > ((u.shift_date + b.start_time) at time zone 'America/Los_Angeles')
    ) then
      v_lane := 'lensed_capacity:' || p_owner::text || ':' || u.team || ':' || u.shift_date::text;
      if not (v_lane = any (v_lanes)) then v_lanes := v_lanes || v_lane; end if;
    end if;
  end loop;

  -- ── 2. Lock every touched lane, ALWAYS IN SORTED ORDER. Two concurrent batches that overlap on
  --       two lanes would deadlock if each took them in its own arbitrary order; sorting makes the
  --       acquisition order global. A batch that touches no capacity-managed lane takes no lock at
  --       all, so unrelated scheduling is never serialised.
  select coalesce(array_agg(l order by l), '{}') into v_lanes from (select distinct unnest(v_lanes) as l) s;
  foreach v_lane in array v_lanes loop
    perform pg_advisory_xact_lock(hashtextextended(v_lane, 0));
  end loop;

  -- ── 3. REMOVALS FIRST. A batch that moves someone off Wednesday night and someone else on must
  --       see the freed setup, so the deletes and cancels land before any recount. Both re-assert
  --       the same predicates the pre-157 statements used, so a row that changed underneath us is
  --       left alone rather than destroyed.
  delete from public.shift_instances
   where user_id = p_owner and source = 'admin_open' and status = 'scheduled'
     and id = any (coalesce(p_delete_ids, '{}'::uuid[]));
  get diagnostics v_n = row_count; v_removed := v_removed + v_n;

  update public.shift_instances set status = 'cancelled'
   where user_id = p_owner and status = 'scheduled'
     and id = any (coalesce(p_cancel_ids, '{}'::uuid[]));
  get diagnostics v_n = row_count; v_removed := v_removed + v_n;

  -- ── 4. The upserts, one at a time and in a deterministic order. Sequential is deliberate: each
  --       recount must see the rows this same batch has already written, or a single batch could
  --       put eleven people into a block of ten without any concurrency at all.
  for u in
    select x.employee_id, x.shift_date, x.starts_at, x.ends_at, x.status, x.source,
           x.shift_rule_id, x.store_id, x.role,
           (case
              when lower(btrim(coalesce(e.role, ''))) in ('host', 'live host') then 'host'
              when lower(btrim(coalesce(e.role, ''))) = 'fulfillment' then 'fulfillment'
              else 'other'
            end) as team
      from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb))
           as x(employee_id uuid, shift_date date, starts_at timestamptz, ends_at timestamptz,
                status text, source text, shift_rule_id uuid, store_id uuid, role text)
      join public.employees e on e.id = x.employee_id and e.user_id = p_owner
     order by x.shift_date, x.employee_id
  loop
    v_blocked := null;

    -- Every ACTIVE block this proposed span would sit inside, on this date.
    for blk in
      select b.id, b.capacity,
             ((u.shift_date + b.start_time) at time zone 'America/Los_Angeles') as starts_at,
             (((case when b.end_time <= b.start_time then u.shift_date + 1 else u.shift_date end) + b.end_time)
               at time zone 'America/Los_Angeles') as ends_at
        from public.shift_capacity_blocks b
       where b.user_id = p_owner and b.active and b.team = u.team
         and extract(dow from u.shift_date)::smallint = any (b.days_of_week)
       order by b.start_time, b.id
    loop
      if not (u.starts_at < blk.ends_at and u.ends_at > blk.starts_at) then continue; end if;

      -- IS THIS AN ADDITION? A row this employee ALREADY has on this date that already overlaps
      -- this block is not new staffing — editing its time, or re-saving it unchanged, must keep
      -- working even when the block is over capacity. Only a genuinely new occupant is gated.
      select exists (
        select 1 from public.shift_instances si
         where si.user_id = p_owner and si.employee_id = u.employee_id and si.shift_date = u.shift_date
           and si.status in ('scheduled', 'claimed')
           and si.starts_at < blk.ends_at and si.ends_at > blk.starts_at
      ) into v_already;
      if v_already then continue; end if;

      -- THE RECOUNT, under the lane lock, with this batch's own earlier writes already applied.
      -- Identical predicate to 156's, including the absence of any offer_state clause.
      select count(*) into v_staffed
        from public.shift_instances si
        join public.employees e2 on e2.id = si.employee_id
       where si.user_id = p_owner and e2.user_id = p_owner
         and si.employee_id is not null
         and si.status in ('scheduled', 'claimed')
         and si.starts_at < blk.ends_at and si.ends_at > blk.starts_at
         and (case
                when lower(btrim(coalesce(e2.role, ''))) in ('host', 'live host') then 'host'
                when lower(btrim(coalesce(e2.role, ''))) = 'fulfillment' then 'fulfillment'
                else 'other'
              end) = u.team;

      v_capacity := coalesce(
        (select s.capacity from public.shift_capacity_settings s
          where s.user_id = p_owner and s.block_id = blk.id and s.date = u.shift_date),
        blk.capacity,
        (select s.capacity from public.shift_capacity_settings s
          where s.user_id = p_owner and s.team = u.team and s.block_id is null));

      -- NOT CONFIGURED ⇒ NO LIMIT. A team that has not set a number schedules exactly as it did
      -- before this migration existed; there is no invisible ceiling to trip over.
      if v_capacity is null then continue; end if;

      if v_staffed >= v_capacity then
        v_blocked := jsonb_build_object(
          'employee_id', u.employee_id, 'shift_date', u.shift_date, 'code', 'OVER_CAPACITY',
          'block_id', blk.id, 'staffed', v_staffed, 'capacity', v_capacity);
        exit;   -- one refused block is enough to refuse the row
      end if;
    end loop;

    if v_blocked is not null then
      v_refusals := v_refusals || v_blocked;
      continue;                                   -- refuse ONLY this row; the rest still apply
    end if;

    select id into v_existing_id from public.shift_instances
     where user_id = p_owner and employee_id = u.employee_id and shift_date = u.shift_date;

    -- The same column set the PostgREST upsert wrote, so columns outside it (note, offer_*,
    -- released_*, excused*) are left exactly as they were on an update — unchanged behaviour.
    insert into public.shift_instances
      (user_id, employee_id, shift_date, starts_at, ends_at, status, source, shift_rule_id, store_id, role)
    values
      (p_owner, u.employee_id, u.shift_date, u.starts_at, u.ends_at, u.status, u.source,
       u.shift_rule_id, u.store_id, u.role)
    on conflict (employee_id, shift_date) do update
      set user_id = excluded.user_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
          status = excluded.status, source = excluded.source,
          shift_rule_id = excluded.shift_rule_id, store_id = excluded.store_id, role = excluded.role;

    if v_existing_id is null then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'updated', v_updated,
    'removed', v_removed,
    'refusals', v_refusals);
end;
$body$;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- lensed_assign_released_shift — the legacy open board's one count-increasing statement.
--
-- A released row has employee_id NULL, so it is NOT staffed. Assigning someone to it adds one to
-- the block, exactly like scheduling them. claim.ts (auto-approve under 40h) and adminShifts.ts
-- (approveClaim, the over-40h path) each did that with a single CAS update; both now call this,
-- which performs THE SAME CAS under the lane lock with a recount in front of it. Their surrounding
-- shift_claims / attendance_events bookkeeping is untouched.
--
-- Returns the same three fields the CAS used to select, so the callers' "null means we lost the
-- race" branch is unchanged, plus an explicit NO_CAPACITY refusal.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.lensed_assign_released_shift(
  p_owner       uuid,
  p_instance_id uuid,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_inst      public.shift_instances;
  v_team      text;
  blk         record;
  v_staffed   int;
  v_capacity  int;
  v_won       public.shift_instances;
begin
  if p_owner is null or p_instance_id is null or p_employee_id is null then
    raise exception 'INVALID_ARGS';
  end if;

  -- Peek without a row lock so the advisory lock is always acquired first (the 156 discipline).
  select * into v_inst from public.shift_instances where id = p_instance_id and user_id = p_owner;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_FOUND');
  end if;

  select (case
            when lower(btrim(coalesce(e.role, ''))) in ('host', 'live host') then 'host'
            when lower(btrim(coalesce(e.role, ''))) = 'fulfillment' then 'fulfillment'
            else 'other'
          end) into v_team
    from public.employees e where e.id = p_employee_id and e.user_id = p_owner;
  if v_team is null then
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('lensed_capacity:' || p_owner::text || ':' || v_team || ':' || v_inst.shift_date::text, 0));

  for blk in
    select b.id, b.capacity,
           ((v_inst.shift_date + b.start_time) at time zone 'America/Los_Angeles') as starts_at,
           (((case when b.end_time <= b.start_time then v_inst.shift_date + 1 else v_inst.shift_date end) + b.end_time)
             at time zone 'America/Los_Angeles') as ends_at
      from public.shift_capacity_blocks b
     where b.user_id = p_owner and b.active and b.team = v_team
       and extract(dow from v_inst.shift_date)::smallint = any (b.days_of_week)
     order by b.start_time, b.id
  loop
    if not (v_inst.starts_at < blk.ends_at and v_inst.ends_at > blk.starts_at) then continue; end if;

    select count(*) into v_staffed
      from public.shift_instances si
      join public.employees e2 on e2.id = si.employee_id
     where si.user_id = p_owner and e2.user_id = p_owner
       and si.employee_id is not null
       and si.status in ('scheduled', 'claimed')
       and si.starts_at < blk.ends_at and si.ends_at > blk.starts_at
       and (case
              when lower(btrim(coalesce(e2.role, ''))) in ('host', 'live host') then 'host'
              when lower(btrim(coalesce(e2.role, ''))) = 'fulfillment' then 'fulfillment'
              else 'other'
            end) = v_team;

    v_capacity := coalesce(
      (select s.capacity from public.shift_capacity_settings s
        where s.user_id = p_owner and s.block_id = blk.id and s.date = v_inst.shift_date),
      blk.capacity,
      (select s.capacity from public.shift_capacity_settings s
        where s.user_id = p_owner and s.team = v_team and s.block_id is null));

    -- NOT CONFIGURED ⇒ NO LIMIT, as above.
    if v_capacity is null then continue; end if;

    if v_staffed >= v_capacity then
      return jsonb_build_object('ok', false, 'reason', 'NO_CAPACITY',
        'staffed', v_staffed, 'capacity', v_capacity);
    end if;
  end loop;

  -- THE CAS, byte-for-byte the predicates the callers used before.
  update public.shift_instances
     set status = 'claimed', employee_id = p_employee_id, source = 'claim', released_at = null
   where id = p_instance_id and user_id = p_owner and status = 'released' and employee_id is null
  returning * into v_won;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_CLAIMED');
  end if;

  return jsonb_build_object('ok', true, 'id', v_won.id, 'shift_date', v_won.shift_date, 'user_id', v_won.user_id);
end;
$body$;

-- Grants: service_role ONLY, matching every other lensed_* write RPC and CONVENTIONS.md. Both take
-- p_owner explicitly and have no auth.uid() to trust, so granting `authenticated` would let any
-- signed-in user write shifts inside another tenant.
-- (Both registered in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs.)
revoke execute on function public.lensed_apply_schedule_batch(uuid, jsonb, uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.lensed_apply_schedule_batch(uuid, jsonb, uuid[], uuid[]) to service_role;

revoke execute on function public.lensed_assign_released_shift(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.lensed_assign_released_shift(uuid, uuid, uuid) to service_role;

commit;
