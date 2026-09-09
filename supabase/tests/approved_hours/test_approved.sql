-- APPROVED HOURS (migration 137). Every assertion is about one of three properties:
--   1. the approved duration is SERVER-ONLY (the guard),
--   2. a LIVE HOST cannot be confirmed without one,
--   3. no path that writes it ever touches the punch.
\set QUIET on
set client_min_messages = notice;

create table if not exists t_results(seq serial, label text, ok boolean, detail text);
truncate t_results;

create or replace function t_eq(p_label text, p_actual anyelement, p_expected anyelement) returns void
language plpgsql as $$
begin
  if p_actual is not distinct from p_expected then
    insert into t_results(label, ok, detail) values (p_label, true, 'got '||coalesce(p_actual::text,'NULL'));
  else
    insert into t_results(label, ok, detail) values (p_label, false,
      'got '||coalesce(p_actual::text,'NULL')||' expected '||coalesce(p_expected::text,'NULL'));
  end if;
end $$;

-- The statement must fail, and fail BY THE NAMED RULE (constraint name or message substring).
create or replace function t_reject(p_label text, p_sql text, p_expect text) returns void
language plpgsql as $$
declare v_con text; v_msg text;
begin
  begin
    execute p_sql;
    insert into t_results(label, ok, detail) values (p_label, false, 'ACCEPTED but should have been rejected');
    return;
  exception when others then
    get stacked diagnostics v_con = CONSTRAINT_NAME, v_msg = MESSAGE_TEXT;
  end;
  if coalesce(v_con,'') = p_expect or v_msg like '%'||p_expect||'%' then
    insert into t_results(label, ok, detail) values (p_label, true, 'rejected by '||coalesce(nullif(v_con,''), v_msg));
  else
    insert into t_results(label, ok, detail) values (p_label, false,
      'rejected by WRONG rule: con='||coalesce(v_con,'-')||' msg='||v_msg||' (expected '||p_expect||')');
  end if;
end $$;

create or replace function t_report(p_section text) returns void language plpgsql as $$
declare r record; n_pass int; n_fail int;
begin
  for r in select label, ok, detail from t_results order by seq loop
    raise notice '%  %  — %', case when r.ok then 'PASS' else 'FAIL' end, rpad(r.label, 62), r.detail;
  end loop;
  select count(*) filter (where ok), count(*) filter (where not ok) into n_pass, n_fail from t_results;
  raise notice '';
  raise notice '%: % passed, % FAILED', p_section, n_pass, n_fail;
  delete from t_results;
  if n_fail > 0 then raise exception 'SECTION FAILED: % (% failures)', p_section, n_fail; end if;
end $$;

-- ── the world: one owner, a LIVE HOST and a FULFILLMENT employee ──────────────────────────────
insert into auth.users(id) values ('a0000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.employees(id, user_id, name, role, status, hourly_rate) values
  ('e1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Carlos','host','active',20),
  ('e2222222-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','Madison','fulfillment','active',20),
  ('e3333333-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','Lee','Live Host','active',20)
on conflict do nothing;

set "test.user_id" = 'a0000000-0000-4000-8000-000000000001';

-- A closed time-clock punch + its raw entry, exactly as lensed_clock_out would leave them:
-- Carlos punched 5:48 PM → 2:20 AM (8h32m). Verified live time is 7h58m = 478 minutes.
create or replace function mk_punch(p_emp uuid, p_date date default '2026-09-08')
returns uuid language plpgsql as $$
declare v_shift uuid; v_in timestamptz; v_out timestamptz;
begin
  v_in  := (p_date + time '17:48') at time zone 'America/Los_Angeles';
  v_out := (p_date + interval '1 day' + time '02:20') at time zone 'America/Los_Angeles';
  insert into public.shifts(user_id, employee_id, date, start_time, end_time, source, confirmed_at,
                            break_minutes, clock_in_at, clock_out_at)
  values ('a0000000-0000-4000-8000-000000000001', p_emp, p_date, '17:48', '02:20', 'time_clock', null,
          0, v_in, v_out)
  returning id into v_shift;
  insert into public.employee_time_entries(user_id, employee_id, shift_id, clocked_in_at, clocked_out_at, status)
  values ('a0000000-0000-4000-8000-000000000001', p_emp, v_shift, v_in, v_out, 'closed');
  return v_shift;
end $$;

do $$
declare
  carlos uuid := 'e1111111-0000-4000-8000-000000000001';
  madison uuid := 'e2222222-0000-4000-8000-000000000002';
  lee uuid := 'e3333333-0000-4000-8000-000000000003';
  s uuid; s2 uuid; res jsonb; before_in timestamptz; before_out timestamptz; v_rows int;
begin
  delete from public.employee_time_entries; delete from public.shifts;

  -- ═══ 1. THE COLUMN, ITS DEFAULT AND ITS BOUND ═══
  s := mk_punch(madison);
  perform t_eq('a fresh punch has NO approval', (select approved_minutes from public.shifts where id = s), null::integer);
  perform t_reject('CHECK: negative approved minutes',
    format('update public.shifts set approved_minutes = -1 where id = %L', s), 'CONFIRMATION_IS_SERVER_ONLY');
  -- (the guard fires first — which is itself the point; the CHECK is proved via the RPC below)

  -- ═══ 2. THE GUARD — a direct write can never set the payable duration ═══
  perform t_reject('direct UPDATE of approved_minutes is refused',
    format('update public.shifts set approved_minutes = 478 where id = %L', s), 'CONFIRMATION_IS_SERVER_ONLY');
  perform t_reject('direct UPDATE of confirmed_at is still refused',
    format('update public.shifts set confirmed_at = now() where id = %L', s), 'CONFIRMATION_IS_SERVER_ONLY');
  -- An ordinary attendance edit is UNAFFECTED: the punch editor must keep working. (A
  -- data-modifying CTE cannot live in a subquery expression, so count the rows the plain way.)
  update public.shifts set start_time = '17:50' where id = s;
  get diagnostics v_rows = row_count;
  perform t_eq('a plain punch edit still succeeds (guard is scoped to the payroll columns)', v_rows, 1);

  -- ═══ 3. FULFILLMENT CONFIRM — approved minutes optional, and recorded when given ═══
  res := public.lensed_confirm_time_clock_shift(s, 482);
  perform t_eq('fulfillment confirm returns ok', (res->>'approved_minutes'), '482');
  perform t_eq('…and stores it', (select approved_minutes from public.shifts where id = s), 482);
  perform t_eq('…and stamps the audit trail', (select confirmed_by from public.shifts where id = s), 'a0000000-0000-4000-8000-000000000001'::uuid);

  -- Legacy call shape (one argument) still resolves via the DEFAULT — no ambiguity, no error.
  s2 := mk_punch(madison, '2026-09-09');
  res := public.lensed_confirm_time_clock_shift(s2);
  perform t_eq('one-argument confirm still works for fulfillment', (res->>'confirmed_at' is not null), true);
  perform t_eq('…and leaves approved_minutes NULL (legacy fallback)',
    (select approved_minutes from public.shifts where id = s2), null::integer);

  -- ═══ 4. RANGE, through the RPC ═══
  perform t_reject('RPC refuses more than 24h',
    format('select public.lensed_confirm_time_clock_shift(%L, 1441)', s), 'APPROVED_MINUTES_OUT_OF_RANGE');
  perform t_reject('RPC refuses negative',
    format('select public.lensed_confirm_time_clock_shift(%L, -1)', s), 'APPROVED_MINUTES_OUT_OF_RANGE');

  -- ═══ 5. THE PUNCH IS NEVER MOVED ═══
  select clock_in_at, clock_out_at into before_in, before_out from public.shifts where id = s;
  res := public.lensed_set_approved_minutes(s, 478);
  perform t_eq('correction stores the new duration', (select approved_minutes from public.shifts where id = s), 478);
  perform t_eq('clock_in_at is byte-identical after approval', (select clock_in_at from public.shifts where id = s), before_in);
  perform t_eq('clock_out_at is byte-identical after approval', (select clock_out_at from public.shifts where id = s), before_out);
  perform t_eq('the raw time entry is untouched too',
    (select clocked_out_at from public.employee_time_entries where shift_id = s), before_out);

  perform t_report('column, guard, fulfillment confirm, punch immutability');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LIVE HOST — an explicit approved duration is REQUIRED
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  carlos uuid := 'e1111111-0000-4000-8000-000000000001';
  lee uuid := 'e3333333-0000-4000-8000-000000000003';
  s uuid; s2 uuid; res jsonb;
begin
  delete from public.employee_time_entries; delete from public.shifts;
  s := mk_punch(carlos);

  -- The NEW two-argument RPC carries the host rule. A stated NULL is a refusal: that is the exact
  -- shape the app sends when the manager left the hours box blank. (The legacy one-argument overload
  -- kept by 137 is deliberately NOT bound by this rule — see its own section below.)
  perform t_reject('a live host CANNOT be confirmed without approved minutes',
    format('select public.lensed_confirm_time_clock_shift(%L, null)', s), 'HOST_APPROVED_MINUTES_REQUIRED');
  perform t_eq('…and the refusal wrote nothing', (select confirmed_at from public.shifts where id = s), null::timestamptz);
  perform t_eq('…including no approval', (select approved_minutes from public.shifts where id = s), null::integer);

  -- The whole point: the host is NOT silently paid their clocked span (8h32m = 512 minutes).
  perform t_eq('a refused host confirm leaves NO figure that could pay 512 minutes',
    (select coalesce(approved_minutes, -1) from public.shifts where id = s), -1);

  res := public.lensed_confirm_time_clock_shift(s, 478);
  perform t_eq('with 7h58m stated, the host confirms', (res->>'approved_minutes'), '478');
  perform t_eq('…and it is NOT the clocked span',
    (select approved_minutes <> 512 from public.shifts where id = s), true);

  -- 'Live Host' (free-text spelling) is recognised by the same predicate.
  s2 := mk_punch(lee, '2026-09-10');
  perform t_reject('the "Live Host" spelling is also required to state hours',
    format('select public.lensed_confirm_time_clock_shift(%L, null)', s2), 'HOST_APPROVED_MINUTES_REQUIRED');

  -- ═══ UNCONFIRM withdraws the approval with the confirmation ═══
  res := public.lensed_unconfirm_time_clock_shift(s);
  perform t_eq('unconfirm clears confirmed_at', (res->>'confirmed_at'), null);
  perform t_eq('…and clears the approval', (select approved_minutes from public.shifts where id = s), null::integer);
  perform t_eq('…but never the punch',
    (select clock_in_at is not null and clock_out_at is not null from public.shifts where id = s), true);

  -- ═══ The correction RPC refuses an unconfirmed time-clock shift ═══
  perform t_reject('approving an unconfirmed punch is refused',
    format('select public.lensed_set_approved_minutes(%L, 400)', s), 'SHIFT_NOT_CONFIRMED');

  -- ═══ Withdrawing an approval on a confirmed shift returns it to the legacy calculation ═══
  perform public.lensed_confirm_time_clock_shift(s, 478);
  perform public.lensed_set_approved_minutes(s, null);
  perform t_eq('an approval can be withdrawn without unconfirming',
    (select approved_minutes is null and confirmed_at is not null from public.shifts where id = s), true);

  perform t_report('live host requirement, unconfirm, correction');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- THE LEGACY ONE-ARGUMENT OVERLOAD — transition compatibility during the deployment window
--
-- 137 is ADDITIVE: it keeps lensed_confirm_time_clock_shift(uuid) so the app version deployed
-- BEFORE Approved Hours keeps confirming while the migration is live and the new code is not out
-- yet. That old client has no hours box to type into, so the legacy path must behave exactly as it
-- did before 137 — confirm the punch, write no approval, and above all GUESS NOTHING. A shift
-- confirmed this way reads approved_minutes IS NULL, which paidShiftHours() resolves to the legacy
-- clocked calculation: identical pay to what that same confirmation produced yesterday.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  carlos uuid := 'e1111111-0000-4000-8000-000000000001';
  madison uuid := 'e2222222-0000-4000-8000-000000000002';
  s uuid; s2 uuid; s3 uuid; res jsonb; before_in timestamptz; before_out timestamptz;
begin
  delete from public.employee_time_entries; delete from public.shifts;

  -- A LIVE HOST through the legacy call CONFIRMS. Refusing here is what would break every
  -- confirmation in the currently deployed app the moment 137 is applied.
  s := mk_punch(carlos);
  select clock_in_at, clock_out_at into before_in, before_out from public.shifts where id = s;
  res := public.lensed_confirm_time_clock_shift(s);
  perform t_eq('the legacy 1-arg call confirms a live host (pre-137 behaviour, unchanged)',
    (res->>'confirmed_at') is not null, true);
  perform t_eq('…and leaves approved_minutes NULL — it guesses NO live duration',
    (select approved_minutes from public.shifts where id = s), null::integer);
  perform t_eq('…so that shift keeps the legacy clocked calculation for payroll',
    (select approved_minutes is null and confirmed_at is not null from public.shifts where id = s), true);
  perform t_eq('…and it never reports an approval it did not make',
    (res ? 'approved_minutes'), false);
  perform t_eq('…and the raw punch is untouched by the legacy path too',
    (select clock_in_at = before_in and clock_out_at = before_out from public.shifts where id = s), true);
  perform t_eq('…and 137''s widened guard did not break it (confirmed_by is stamped)',
    (select confirmed_by from public.shifts where id = s), 'a0000000-0000-4000-8000-000000000001'::uuid);

  -- After the code deploy the manager fixes such a shift WITHOUT unconfirming it: the correction
  -- RPC is the migration path for anything confirmed during the window.
  perform public.lensed_set_approved_minutes(s, 478);
  perform t_eq('a legacy-confirmed host shift can be approved afterwards, no unconfirm needed',
    (select approved_minutes from public.shifts where id = s), 478);
  perform t_eq('…and that correction still did not touch the punch',
    (select clock_in_at = before_in and clock_out_at = before_out from public.shifts where id = s), true);

  -- Fulfillment through the legacy call: same as before 137 in every respect.
  s2 := mk_punch(madison, '2026-09-11');
  res := public.lensed_confirm_time_clock_shift(s2);
  perform t_eq('the legacy call still confirms fulfillment',
    (res->>'confirmed_at') is not null, true);
  perform t_eq('…with no approval written', (select approved_minutes from public.shifts where id = s2), null::integer);
  -- 071 promised idempotence (double-tap safety); the widened guard must not have cost it.
  res := public.lensed_confirm_time_clock_shift(s2);
  perform t_eq('the legacy call is still idempotent', (res->>'confirmed_at') is not null, true);
  perform t_eq('…and the repeat did not invent an approval',
    (select approved_minutes from public.shifts where id = s2), null::integer);

  -- The guard is unchanged for everyone: keeping the legacy RPC did not open a direct-write door.
  --
  -- ONE THING TO KNOW ABOUT ASSERTING THE GUARD HERE: every confirm/correction RPC unlocks the
  -- guarded columns with set_config('lensed.confirm_ctx','on', TRUE) — transaction-local, which is
  -- 070/071 behaviour that 137 does not change. PostgREST runs each RPC in its own transaction, so
  -- in production that unlock dies with the request and a later direct UPDATE from the same client
  -- arrives in a fresh, locked transaction. This DO block is a SINGLE transaction that has already
  -- called those RPCs above, so it is still legitimately unlocked and must clear the flag by hand
  -- to model a fresh request. Without this line the next two assertions would pass trivially.
  perform set_config('lensed.confirm_ctx', '', true);
  s3 := mk_punch(madison, '2026-09-12');
  perform t_reject('a direct UPDATE still cannot confirm, legacy overload or not',
    format('update public.shifts set confirmed_at = now() where id = %L', s3), 'CONFIRMATION_IS_SERVER_ONLY');
  perform t_reject('…nor set an approval',
    format('update public.shifts set approved_minutes = 60 where id = %L', s3), 'CONFIRMATION_IS_SERVER_ONLY');

  -- Both call shapes are reachable in the SAME transaction: proof there is no overload ambiguity.
  -- If the new argument had a default, one of these two lines would raise "function is not unique".
  -- (These RPCs unlock the guard again, so they come AFTER the two guard assertions above.)
  perform public.lensed_confirm_time_clock_shift(s3);
  perform t_eq('1-arg then 2-arg on the same shift both resolve (no ambiguity)',
    (public.lensed_confirm_time_clock_shift(s3, 300)->>'approved_minutes'), '300');
  perform t_eq('…and the two-argument call is what wrote the figure',
    (select approved_minutes from public.shifts where id = s3), 300);

  perform t_report('legacy one-argument overload (transition compatibility)');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- TENANCY — another owner's shift is simply not found
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
insert into auth.users(id) values ('b0000000-0000-4000-8000-000000000002') on conflict do nothing;
do $$
declare
  madison uuid := 'e2222222-0000-4000-8000-000000000002';
  s uuid;
begin
  delete from public.employee_time_entries; delete from public.shifts;
  s := mk_punch(madison);
  perform public.lensed_confirm_time_clock_shift(s, 480);

  perform set_config('test.user_id', 'b0000000-0000-4000-8000-000000000002', true);
  perform t_reject('a foreign owner cannot confirm it',
    format('select public.lensed_confirm_time_clock_shift(%L, 60)', s), 'SHIFT_NOT_FOUND');
  perform t_reject('a foreign owner cannot change its approved minutes',
    format('select public.lensed_set_approved_minutes(%L, 60)', s), 'SHIFT_NOT_FOUND');
  -- A shift UUID is not a capability. The foreign owner holds a perfectly valid `authenticated`
  -- session and the correct id; the tenant predicate inside the SELECT is what refuses them.
  perform t_reject('a foreign owner cannot unconfirm it either',
    format('select public.lensed_unconfirm_time_clock_shift(%L)', s), 'SHIFT_NOT_FOUND');
  perform t_reject('…nor confirm it through the LEGACY overload',
    format('select public.lensed_confirm_time_clock_shift(%L)', s), 'SHIFT_NOT_FOUND');
  perform t_reject('…nor withdraw the approval by passing null',
    format('select public.lensed_set_approved_minutes(%L, null)', s), 'SHIFT_NOT_FOUND');

  perform set_config('test.user_id', 'a0000000-0000-4000-8000-000000000001', true);
  perform t_eq('the approval is unchanged after every cross-owner attempt',
    (select approved_minutes from public.shifts where id = s), 480);
  perform t_eq('…and so is the confirmation',
    (select confirmed_at is not null from public.shifts where id = s), true);
  perform t_eq('…and so is the punch',
    (select clock_in_at is not null and clock_out_at is not null from public.shifts where id = s), true);

  perform t_report('tenancy');
end $$;
