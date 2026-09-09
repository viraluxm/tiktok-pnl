-- 137_shift_approved_minutes.sql — APPROVED HOURS: the manager-confirmed payable duration,
-- stored separately from the attendance punch.
--
-- ⚠️ NOT APPLIED. This DB has NO migration ledger — migrations are applied BY HAND and the repo
--    file is the only record (see CONVENTIONS.md). Prefix 137 was free across origin/main, every
--    local and remote branch, and every sibling worktree at authoring time (136 is the highest
--    claimed, on this branch, and is ALSO unapplied).
--    ➜ RE-INSPECT THE LIVE SCHEMA BEFORE APPLYING: confirm public.shifts has no approved_minutes
--      column (verified absent 2026-09-08, read-only) and that the two confirm functions still
--      match the bodies rebuilt below.
--
-- ⚠️ DEPLOY ORDER — APPLY THIS **WITH OR AFTER** THE CODE DEPLOY, NEVER BEFORE.
--    The confirm RPC below REFUSES to confirm a LIVE HOST shift without an explicit approved
--    duration (HOST_APPROVED_MINUTES_REQUIRED). The manager UI that collects that value ships in
--    the same change. Between an early apply and the code deploy, host confirmations would be
--    refused — loudly, and with nothing written. That is the safe failure and the whole point of
--    this migration: a host's clocked span must never become payroll by default. Fulfillment
--    confirmations keep working throughout (the new argument is DEFAULTed, so the old one-argument
--    call still resolves).
--
-- LOCK FOOTPRINT (CLAUDE.md "classify by LOCK FOOTPRINT"): CLASS A.
--   • `add column ... integer` NULLABLE WITH NO DEFAULT → catalog-only in PG11+, no table rewrite.
--   • one CHECK on the new column only. It is added NOT VALID and then VALIDATED separately, so the
--     initial ALTER takes ACCESS EXCLUSIVE for an instant and the scan runs under SHARE UPDATE
--     EXCLUSIVE (no writer blocked). Every existing row has NULL and passes trivially.
--   • `create or replace` on shifts_guard_confirmation() — a trigger function on `shifts`. `shifts`
--     is NOT a capture/order-sync table and is not read during a live show, but it IS written by
--     the kiosk clock-out path, so run each group in its own transaction with
--     `set local lock_timeout = '3s'` per the Class A recipe and confirm capture kept landing.
--   • DROP + CREATE on lensed_confirm_time_clock_shift: see the signature note below.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Three different quantities were collapsed into two columns:
--
--   SCHEDULED  what the person was planned to work        → shift_instances (never payable)
--   CLOCKED    what they actually punched                 → shifts.clock_in_at / clock_out_at
--   APPROVED   what payroll should pay                    → had NOWHERE TO LIVE
--
-- For a LIVE HOST, payable time is normally the verified live-session duration, not the whole span
-- between clock-in and clock-out. With no column for the approved figure, the only way to make
-- payroll match live time was to EDIT THE PUNCH — which destroys the attendance record to move a
-- payroll number. Concretely: Carlos punches 5:48 PM → 2:20 AM (8h32m) but was live 7h58m; the
-- punch was being rewritten to 6:03 PM → 2:01 AM so paidShiftHours would return 7.97.
--
-- After this migration the punch is left alone and `approved_minutes` carries the payable duration.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY MINUTES, AND WHY NOT REUSE AN EXISTING COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 7h58m is 478 minutes exactly; as hours it is 7.9666… — a float that reprints wrong and sums
-- wrong. `break_minutes` already establishes integer minutes as this schema's unit for a duration,
-- so approved time follows it. NULL means "no explicit approval" and is the ONLY way to say that,
-- which is what makes the legacy fallback in src/lib/employees.ts safe (see below).
--
-- No existing column means "final payable duration": `break_minutes` is an input to the legacy
-- calculation, not its result, and the clock instants are attendance. confirmed_at / confirmed_by
-- ARE reused as the approval audit trail rather than duplicated — lensed_set_approved_minutes
-- re-stamps them, so "who approved this number, and when" is always answerable from the row.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THE CONFIRM SIGNATURE CHANGES (and why DROP first)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Confirming a host shift and recording its approved duration MUST be one transaction. If they
-- were two calls and the second failed, the shift would be confirmed with approved_minutes NULL —
-- i.e. payroll would silently fall back to the clocked span, the exact bug this migration removes.
-- So the approved value is an argument to the confirm RPC.
--
-- `create or replace` with a different argument list creates a SECOND overload rather than
-- replacing, and `lensed_confirm_time_clock_shift(p_shift_id => …)` would then be ambiguous
-- ("function is not unique"). The one-argument version is therefore DROPPED explicitly first, the
-- same hazard and the same fix as migration 130's approval RPC.
--
-- Both function bodies below were rebuilt from the LIVE `pg_get_functiondef` output (per
-- CONVENTIONS.md: never hand-copy a create-or-replace from an older migration file). The diff
-- against live is exactly: the new parameter, the host requirement, the approved_minutes write in
-- confirm, and clearing approved_minutes in unconfirm. Nothing else — comments included.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
alter table public.shifts
  add column if not exists approved_minutes integer;

comment on column public.shifts.approved_minutes is
  'FINAL NET PAYABLE duration in whole minutes, as approved by a manager at confirmation. '
  'NULL = no explicit approval; payroll then falls back to the legacy paidShiftHours calculation '
  '(src/lib/employees.ts), which is what keeps historical pay unchanged. For a live host this is '
  'normally the verified live-session duration, NOT the clock-in→clock-out span. The punch '
  '(clock_in_at / clock_out_at) is the attendance record and is never edited to move this number. '
  'Server-only: guarded by shifts_guard_confirmation, writable solely by the lensed_*approved* RPCs.';

-- Sanity bound only. 0 is legitimate (a shift approved as unpayable); 1440 = 24h is the ceiling for
-- one shift's payable time and catches a seconds-for-minutes fat-finger (478 vs 28680). NOT VALID
-- first so the initial ALTER does not scan the table under ACCESS EXCLUSIVE; every existing row is
-- NULL, so the VALIDATE that follows is a formality.
alter table public.shifts drop constraint if exists shifts_approved_minutes_range;
alter table public.shifts
  add constraint shifts_approved_minutes_range
  check (approved_minutes is null or (approved_minutes >= 0 and approved_minutes <= 1440))
  not valid;
alter table public.shifts validate constraint shifts_approved_minutes_range;

-- The pay read and the manager queue both filter on confirmation, not on this column, so no index
-- is added: a partial index on approved_minutes would serve no query that exists.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE GUARD — approved_minutes is SERVER-ONLY, exactly like confirmation
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Rebuilt from live prosrc; the only change is adding approved_minutes to the guarded set. Without
-- this, any PostgREST caller holding an authenticated session could set their own payable duration
-- with a plain `update shifts set approved_minutes = …`. The employee portal is service-role and
-- read-only over `shifts`, but the guard is what makes that a property of the DATABASE rather than
-- a property of the code that happens to exist today.
create or replace function public.shifts_guard_confirmation()
returns trigger
language plpgsql
as $function$
begin
  if (new.confirmed_at is distinct from old.confirmed_at
      or new.confirmed_by is distinct from old.confirmed_by
      or new.approved_minutes is distinct from old.approved_minutes)
     and coalesce(current_setting('lensed.confirm_ctx', true), '') <> 'on' then
    raise exception 'CONFIRMATION_IS_SERVER_ONLY'
      using hint = 'Change confirmation via lensed_confirm_time_clock_shift / lensed_unconfirm_time_clock_shift; change approved minutes via lensed_set_approved_minutes';
  end if;
  return new;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 3. CONFIRM — now records the approved duration, and requires it for a live host
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists public.lensed_confirm_time_clock_shift(uuid);

create or replace function public.lensed_confirm_time_clock_shift(
  p_shift_id uuid,
  p_approved_minutes integer default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_shift public.shifts;
  v_entry public.employee_time_entries;
  v_is_host boolean;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if p_approved_minutes is not null and (p_approved_minutes < 0 or p_approved_minutes > 1440) then
    raise exception 'APPROVED_MINUTES_OUT_OF_RANGE';
  end if;

  -- Own the shift; it must be a COMPLETED time-clock shift.
  select * into v_shift from public.shifts
    where id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.source <> 'time_clock' then raise exception 'SHIFT_NOT_TIME_CLOCK'; end if;
  if v_shift.end_time is null then raise exception 'SHIFT_NOT_CLOSED'; end if;

  -- The linked raw time entry must be CLOSED with no dangling break.
  select * into v_entry from public.employee_time_entries
    where shift_id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'TIME_ENTRY_NOT_FOUND'; end if;
  if v_entry.clocked_out_at is null or v_entry.status <> 'closed' then
    raise exception 'TIME_ENTRY_NOT_CLOSED';
  end if;
  if exists (
    select 1 from public.employee_time_breaks
    where time_entry_id = v_entry.id and ended_at is null
  ) then
    raise exception 'BREAK_OPEN';
  end if;

  -- LIVE HOST: payable time is verified live time, so it must be stated, never inferred from the
  -- punch. The role predicate mirrors the 'host' branch of teamOfRole() in src/lib/timeclock.ts
  -- (the app's one role normalisation); src/lib/employees.approvedHours.test.mjs asserts the two
  -- agree on the vocabulary so this cannot drift silently.
  select lower(btrim(e.role)) in ('host', 'live host')
    into v_is_host
    from public.employees e
   where e.id = v_shift.employee_id and e.user_id = v_user;
  if v_is_host is true and p_approved_minutes is null and v_shift.approved_minutes is null then
    raise exception 'HOST_APPROVED_MINUTES_REQUIRED';
  end if;

  -- Idempotent: confirming an already-confirmed shift is a no-op returning current state
  -- (safe against duplicate requests / double taps). Only the first confirm stamps the time.
  -- An approved duration passed alongside is still applied — re-confirming with a corrected
  -- number is how a payroll-only fix reaches an already-confirmed shift from this path.
  if v_shift.confirmed_at is null or p_approved_minutes is not null then
    perform set_config('lensed.confirm_ctx', 'on', true); -- unlock the guarded columns for THIS txn only
    update public.shifts
       set confirmed_at = coalesce(confirmed_at, now()),
           confirmed_by = coalesce(confirmed_by, v_user),
           approved_minutes = coalesce(p_approved_minutes, approved_minutes)
     where id = p_shift_id;
    select * into v_shift from public.shifts where id = p_shift_id;
  end if;

  return jsonb_build_object(
    'id', v_shift.id, 'source', v_shift.source,
    'confirmed_at', v_shift.confirmed_at, 'confirmed_by', v_shift.confirmed_by,
    'approved_minutes', v_shift.approved_minutes
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 4. UNCONFIRM — withdrawing the confirmation withdraws the approval with it
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Rebuilt from live prosrc; the only change is clearing approved_minutes. Leaving an approved
-- duration on an unconfirmed shift would be a half-state: not payable (isPayableShift gates on
-- confirmed_at) yet carrying a number that reads as final. The punch is untouched, as before.
create or replace function public.lensed_unconfirm_time_clock_shift(p_shift_id uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_shift public.shifts;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_shift from public.shifts
    where id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.source <> 'time_clock' then raise exception 'SHIFT_NOT_TIME_CLOCK'; end if;

  if v_shift.confirmed_at is not null or v_shift.confirmed_by is not null
     or v_shift.approved_minutes is not null then
    perform set_config('lensed.confirm_ctx', 'on', true);
    update public.shifts set confirmed_at = null, confirmed_by = null, approved_minutes = null
      where id = p_shift_id;
    select * into v_shift from public.shifts where id = p_shift_id;
  end if;

  return jsonb_build_object(
    'id', v_shift.id, 'source', v_shift.source,
    'confirmed_at', v_shift.confirmed_at, 'confirmed_by', v_shift.confirmed_by,
    'approved_minutes', v_shift.approved_minutes
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 5. PAYROLL-ONLY CORRECTION on an already-confirmed shift
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The point of the whole change: when the attendance record is RIGHT but the payable duration is
-- wrong, fix the duration — do not touch the punch. (When the PUNCH is wrong, the existing punch
-- editor is still the correct tool and is untouched by this migration.)
--
-- Re-stamps confirmed_by / confirmed_at so the audit answer to "who approved this number, and
-- when" always describes the CURRENT number. That reuse is why no separate approval-audit table
-- exists here.
--
-- Accepts NULL to withdraw an approval and fall back to the legacy calculation, which is the only
-- way back out of a mistaken entry without unconfirming the whole shift.
create or replace function public.lensed_set_approved_minutes(
  p_shift_id uuid,
  p_approved_minutes integer
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_shift public.shifts;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if p_approved_minutes is not null and (p_approved_minutes < 0 or p_approved_minutes > 1440) then
    raise exception 'APPROVED_MINUTES_OUT_OF_RANGE';
  end if;

  select * into v_shift from public.shifts
    where id = p_shift_id and user_id = v_user
    for update;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.end_time is null then raise exception 'SHIFT_NOT_CLOSED'; end if;

  -- Approving hours does not confirm a shift. A time-clock shift must already be confirmed for an
  -- approved duration to mean anything (isPayableShift still gates payability on confirmed_at), so
  -- setting one on an unconfirmed punch is refused rather than silently stored.
  if v_shift.source = 'time_clock' and v_shift.confirmed_at is null then
    raise exception 'SHIFT_NOT_CONFIRMED';
  end if;

  perform set_config('lensed.confirm_ctx', 'on', true);
  update public.shifts
     set approved_minutes = p_approved_minutes,
         confirmed_by = case when v_shift.source = 'time_clock' then v_user else confirmed_by end,
         confirmed_at = case when v_shift.source = 'time_clock' then now() else confirmed_at end
   where id = p_shift_id;
  select * into v_shift from public.shifts where id = p_shift_id;

  return jsonb_build_object(
    'id', v_shift.id, 'source', v_shift.source,
    'confirmed_at', v_shift.confirmed_at, 'confirmed_by', v_shift.confirmed_by,
    'approved_minutes', v_shift.approved_minutes
  );
end;
$function$;

-- Grants: these three run as the MANAGER's own session and derive the owner from auth.uid(), so
-- they are granted to `authenticated` exactly like the confirm pair always has been. They are not
-- service-role-only and must NOT be added to SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs.
grant execute on function public.lensed_confirm_time_clock_shift(uuid, integer) to authenticated;
grant execute on function public.lensed_unconfirm_time_clock_shift(uuid)        to authenticated;
grant execute on function public.lensed_set_approved_minutes(uuid, integer)     to authenticated;

commit;
