-- 149_approved_minutes_live_host_only.sql — APPROVED HOURS ARE A LIVE-HOST INSTRUMENT.
-- The server decides who may have one, so hiding the input is no longer the only thing stopping a
-- fulfillment override.
--
-- ⛔ NOT APPLIED TO PRODUCTION. This DB has NO migration ledger — migrations are applied BY HAND
--    and the repo file is the only record (see CONVENTIONS.md), so this line IS the record. Update
--    it to "✅ APPLIED …" with the UTC timestamp at the moment it is applied, and not before.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️  DEPLOY ORDER — CODE FIRST. THIS IS THE OPPOSITE OF 139 AND IT MATTERS.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Migration 139 was fully additive and could go out ahead of its code. THIS ONE CANNOT.
--
-- The client deployed today PREFILLS the approved-hours box for a fulfillment shift with the
-- clocked figure and sends it on every confirm. Section 2 below makes the server IGNORE that
-- argument for a non-host rather than refuse it, precisely so applying this early cannot break
-- confirmation — but section 3 makes lensed_set_approved_minutes REFUSE a non-host outright, and
-- the currently-deployed tile still offers "Adjust approved hours" on a fulfillment shift. A
-- manager clicking it between this migration and the code deploy would get an error.
--
--   ➜ Apply AFTER (or together with) the deploy of the branch that removes those controls.
--   ➜ Applying it early is not a data hazard — nothing is written that would not have been — it
--     is a UI hazard on one button. Do it in the right order anyway.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Within three days of 139 shipping, production held 40 `shifts.approved_minutes` values on
-- FULFILLMENT rows across 16 people. 36 of them differ from the punch only by whole-minute
-- rounding — the prefill storing a lossy copy of the clocked figure back over itself — and one
-- reads 1421 minutes (23h41m) against a 7h40m punch, a $352 overpayment nothing in the UI
-- distinguished from the rest.
--
-- Fulfillment payable time is fully determined by the punch: clock in → clock out − breaks. There
-- is no second opinion to record, so there is no legitimate writer of this column for them. The
-- application enforces that (approvedHoursApply / approvedMinutesForTeam in
-- src/lib/shifts/approvedHours.ts, applied in src/hooks/useShifts.ts), and payroll now ignores the
-- column for them outright (paidShiftHours in src/lib/employees.ts). This migration closes the
-- last gap: a direct PostgREST call from a browser console.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES — AND DOES NOT — CHANGE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--   • lensed_confirm_time_clock_shift(uuid, integer) — REPLACED. One added rule: for a NON-HOST
--     the p_approved_minutes argument is coerced to NULL before it can be written. Every other
--     line, including the live-host requirement, is byte-identical to what production runs today.
--   • lensed_set_approved_minutes(uuid, integer)     — REPLACED. One added rule: a NON-HOST shift
--     is refused with APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM. Everything else is unchanged.
--
--   NOT touched, deliberately:
--   • the legacy one-argument lensed_confirm_time_clock_shift(uuid). It cannot write the column at
--     all (its body never names it), so it is not a hole, and reissuing it would drift a function
--     071 owns.
--   • lensed_unconfirm_time_clock_shift(uuid) — already clears the column for everyone.
--   • shifts_guard_confirmation() — already blocks every direct UPDATE of the column.
--   • the shifts_approved_minutes_range CHECK, the column itself, and every grant.
--
--   ⛔ NO DATA IS MODIFIED. Not one historical approved_minutes value is cleared, and there is no
--      backfill, no UPDATE outside the two function bodies, and no DELETE. The 40 legacy rows stay
--      exactly as they are, as audit history. They pay nothing now because payroll ignores them
--      for a fulfillment employee — clearing them is a separate, separately-approved change.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FIDELITY: BOTH BODIES ARE A DIFF AGAINST LIVE prosrc, NOT A REWRITE FROM THE 139 FILE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Read out of pg_proc on 2026-09-12 and confirmed identical to 139's text before editing:
--   lensed_confirm_time_clock_shift(uuid,integer)  md5(prosrc) d5adb95d2d90eadeaed090e26d3a7ac3  (3301 bytes)
--   lensed_set_approved_minutes(uuid,integer)      md5(prosrc) 347f2bcdda9a1c45fa0f82bcd1e54b51  (1620 bytes)
-- Re-check those two md5s before applying. If either differs, production has drifted from this
-- file and the drift must be understood before it is overwritten.
--
-- PRESERVED VERBATIM from the live definitions (all four were verified, not assumed):
--   • SECURITY INVOKER — neither function is SECURITY DEFINER. They run as the manager's own
--     session and derive the owner from auth.uid(); `create or replace` keeps that, and it is NOT
--     upgraded here. A SECURITY DEFINER version of either would silently widen tenant reach.
--   • set search_path to 'public'  (pg_proc.proconfig = search_path=public)
--   • owner postgres, volatility VOLATILE, returns jsonb, language plpgsql
--   • TENANT ISOLATION: every read and write still carries `user_id = v_user`, including the new
--     employees lookup, which is scoped `e.user_id = v_user` exactly as the existing host lookup
--     in confirm already is. A shift belonging to another owner is SHIFT_NOT_FOUND, as before.
--   • GRANTS: `create or replace` preserves existing grants, and both are re-issued at the bottom
--     anyway (idempotent, and what CONVENTIONS.md requires of any function the app calls from a
--     user session). Neither is service-role-only; neither belongs in SERVICE_ROLE_ONLY.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LOCK FOOTPRINT — Class A-shaped, but it REPLACES live functions, so treat it as Class B
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- No table is rewritten and no column is touched, so nothing takes a heavy lock on `shifts`:
-- `create or replace function` takes an ACCESS EXCLUSIVE lock on the pg_proc ROW only, held for an
-- instant. But CLAUDE.md classifies `create or replace` on a function the app calls as Class B, so
-- it is user-applied, with the usual evidence recorded first: the latest capture_events write and
-- live_sessions.last_seen_at. `lock_timeout` is set regardless — a contended catalogue lock must
-- abort rather than queue in front of the capture path.
--
-- ONE TRANSACTION: the two functions express one rule. Applying half of it would leave the
-- correction RPC as an open door into the column while confirm had already closed.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Re-apply the two function bodies from 139_shift_approved_minutes.sql, sections 3 and 5. They are
-- unchanged there and are the exact pre-149 definitions. No data has to be restored, because none
-- is changed. Rolling back re-opens the fulfillment write path; the application-layer gate in
-- useShifts.ts still closes it for anyone using the app.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '3s';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. CONFIRM — a non-host's approved minutes are IGNORED, never written
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Ignored rather than refused, on purpose. Confirming a shift and approving a duration are one
-- transaction here (139), and confirmation is the part that must never fail for a reason unrelated
-- to it: a manager pressing Confirm on a fulfillment punch is asking to confirm attendance, and an
-- error about an argument their client attached for them is not an answer they can act on. The
-- figure is dropped, which is precisely the end state — approved_minutes stays NULL and
-- paidShiftHours() pays the canonical clocked span.
--
-- v_is_host is NULL when no employee row matches (an orphaned shift). `is true` therefore reads as
-- "not a host", which is the side that writes NOTHING. Both new branches fail safe.
create or replace function public.lensed_confirm_time_clock_shift(
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
  v_entry public.employee_time_entries;
  v_is_host boolean;
  v_approved integer;
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

  -- ── ADDED IN 149 ────────────────────────────────────────────────────────────────────────────
  -- APPROVED HOURS ARE A LIVE-HOST INSTRUMENT. For anyone else the payable duration IS the punch,
  -- so an approved figure has no meaning and is discarded here — including one sent by a client
  -- that has not been redeployed yet, and one typed into a browser console. From this point on
  -- v_approved, not p_approved_minutes, is what the rest of the body may write.
  v_approved := case when v_is_host is true then p_approved_minutes else null end;
  -- ────────────────────────────────────────────────────────────────────────────────────────────

  -- The new client always SENDS this argument, so a NULL here is an explicit "no figure given",
  -- not an omitted parameter. Either way a live host cannot be confirmed without one.
  if v_is_host is true and v_approved is null and v_shift.approved_minutes is null then
    raise exception 'HOST_APPROVED_MINUTES_REQUIRED';
  end if;

  -- Idempotent: confirming an already-confirmed shift is a no-op returning current state
  -- (safe against duplicate requests / double taps). Only the first confirm stamps the time.
  -- An approved duration passed alongside is still applied — re-confirming with a corrected
  -- number is how a payroll-only fix reaches an already-confirmed shift from this path.
  if v_shift.confirmed_at is null or v_approved is not null then
    perform set_config('lensed.confirm_ctx', 'on', true); -- unlock the guarded columns for THIS txn only
    update public.shifts
       set confirmed_at = coalesce(confirmed_at, now()),
           confirmed_by = coalesce(confirmed_by, v_user),
           approved_minutes = coalesce(v_approved, approved_minutes)
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
-- 2. PAYROLL-ONLY CORRECTION — refused outright for a non-host
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- REFUSED here, unlike confirm, because setting the override is this function's ONLY job. There is
-- no other work to complete, so silently doing nothing would report success for a change that did
-- not happen. A caller who wants a fulfillment shift to pay differently must correct the PUNCH.
--
-- Clearing an existing value is refused too, and that is deliberate: this migration does not touch
-- historical data, and letting one path clear rows while the audit is still pending would produce
-- a partial cleanup nobody decided on. Unconfirm still clears the column, as it always has.
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
  v_is_host boolean;
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

  -- ── ADDED IN 149 ────────────────────────────────────────────────────────────────────────────
  -- Same role predicate, same owner scoping, same fail-safe direction as confirm: a NULL v_is_host
  -- (no matching employee row) is NOT a host and is refused.
  select lower(btrim(e.role)) in ('host', 'live host')
    into v_is_host
    from public.employees e
   where e.id = v_shift.employee_id and e.user_id = v_user;
  if v_is_host is distinct from true then
    raise exception 'APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM'
      using hint = 'Approved hours apply to Live Hosts only. Fulfillment shifts are paid their clocked time — correct the punch instead.';
  end if;
  -- ────────────────────────────────────────────────────────────────────────────────────────────

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

comment on function public.lensed_confirm_time_clock_shift(uuid, integer) is
  'Confirm a time-clock shift AND record its final payable duration (approved_minutes) in one '
  'transaction. Approved hours are a LIVE HOST instrument: a live host shift is refused without a '
  'duration (HOST_APPROVED_MINUTES_REQUIRED), and for every other team the argument is IGNORED so '
  'the column stays NULL and payroll pays the canonical clocked span. Never modifies the punch.';

comment on function public.lensed_set_approved_minutes(uuid, integer) is
  'Change ONLY the payable duration of an already-confirmed LIVE HOST shift; the punch is never '
  'touched. Refuses any non-host shift with APPROVED_MINUTES_NOT_ALLOWED_FOR_TEAM — fulfillment '
  'time is paid as clocked, so the correction for one is an edit to the punch.';

-- Grants re-issued idempotently. `create or replace` preserves them, but CONVENTIONS.md requires
-- any function the app calls from a user session to carry its grant in the same migration, and
-- this file may be applied straight through the Management API where CI cannot see it. Both run as
-- the MANAGER's own session (SECURITY INVOKER, owner from auth.uid()), so `authenticated` is
-- correct and neither belongs in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs.
grant execute on function public.lensed_confirm_time_clock_shift(uuid, integer) to authenticated;
grant execute on function public.lensed_set_approved_minutes(uuid, integer)     to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION — run these, record the output, before calling this done
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Each check proves its own lookup found rows, per CONVENTIONS.md: a "nothing bad exists"
-- assertion that matched zero rows reads exactly like one that passed on merit.
--
-- (a) Both functions are still SECURITY INVOKER with search_path=public, and the legacy overload
--     is untouched. Expect 3 rows, security_definer all false, config 'search_path=public'.
--
--     select p.oid::regprocedure::text as sig, p.prosecdef as security_definer,
--            array_to_string(p.proconfig,' | ') as config, pg_get_userbyid(p.proowner) as owner
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('lensed_confirm_time_clock_shift','lensed_set_approved_minutes')
--     order by sig;
--
-- (b) `authenticated` still holds EXECUTE on both. Expect 2 rows, both true — and the row count
--     itself is the proof the lookup matched.
--
--     select p.oid::regprocedure::text as sig,
--            has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_execute
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and (p.proname = 'lensed_set_approved_minutes'
--         or (p.proname = 'lensed_confirm_time_clock_shift'
--             and pg_get_function_identity_arguments(p.oid) = 'p_shift_id uuid, p_approved_minutes integer'));
--
-- (c) NO HISTORICAL DATA MOVED. Take this count immediately BEFORE applying and again after; the
--     two must be identical, and non-zero (40 at the time of writing), or the comparison is
--     vacuous. It must also be re-run against the same snapshot — managers confirm shifts daily.
--
--     select count(*) as rows_with_approved,
--            count(*) filter (where lower(btrim(e.role)) = 'fulfillment') as fulfillment_rows,
--            sum(sh.approved_minutes)                                     as sum_minutes
--     from public.shifts sh join public.employees e on e.id = sh.employee_id
--     where sh.approved_minutes is not null;
--
-- (d) npm run check:rpc-grants against this database.
