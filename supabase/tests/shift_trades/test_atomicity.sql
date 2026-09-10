-- ATOMICITY for lensed_approve_shift_trade.
--
-- Two shapes of failure, two guarantees:
--   1. A collision INSIDE the three-step swap (the target already works the requester's day) must
--      roll all three steps back and return EMPLOYEE_DOUBLE_BOOKED — never leave shift A unowned.
--   2. A failure AFTER the swap (here: the attendance insert) must abort the whole function so the
--      swap itself is undone. `return` past the swap would be a torn state; every path RAISES.
\set QUIET on
set client_min_messages = notice;
delete from public.attendance_events;
delete from public.shift_trades;
delete from public.shift_claims;
delete from public.shift_instances;

-- A trigger the test can arm to make the attendance insert fail (simulates any post-swap fault).
create or replace function t_boom() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('test.boom', true), '') = 'on' then
    raise exception 'BOOM: simulated post-swap failure';
  end if;
  return new;
end $$;
drop trigger if exists t_boom_attendance on public.attendance_events;
create trigger t_boom_attendance before insert on public.attendance_events for each row execute function t_boom();

do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  sa uuid; sb uuid; t uuid; res jsonb; before_a public.shift_instances; before_b public.shift_instances; caught text;
begin
  -- ═══ 1. DOUBLE-BOOKED: Bob already works Alice's day ═══
  sa := mk(alice, '2027-04-01');
  sb := mk(bob,   '2027-04-03');
  perform mk(bob, '2027-04-01');            -- Bob's OTHER shift, same day as A
  t := mkt(alice, sa, bob, sb);
  select * into before_a from public.shift_instances where id = sa;
  select * into before_b from public.shift_instances where id = sb;

  res := public.lensed_approve_shift_trade(A, t, date '2026-09-07');
  perform t_eq('double-book: refused',                          res->>'ok', 'false');
  perform t_eq('double-book: EMPLOYEE_DOUBLE_BOOKED',           res->>'reason', 'EMPLOYEE_DOUBLE_BOOKED');
  perform t_eq('double-book: A FULLY unchanged (never left unowned)',
    (select i from public.shift_instances i where i.id = sa) is not distinct from before_a, true);
  perform t_eq('double-book: B FULLY unchanged',
    (select i from public.shift_instances i where i.id = sb) is not distinct from before_b, true);
  perform t_eq('double-book: trade still pending_manager',      (select status from public.shift_trades where id = t), 'pending_manager');
  perform t_eq('double-book: no attendance written',            (select count(*)::int from public.attendance_events), 0);
  delete from public.shift_trades; delete from public.shift_instances;

  -- ═══ 2. POST-SWAP FAILURE MUST ROLL THE SWAP BACK ═══
  sa := mk(alice, '2027-05-01');
  sb := mk(bob,   '2027-05-03');
  t := mkt(alice, sa, bob, sb);
  select * into before_a from public.shift_instances where id = sa;
  select * into before_b from public.shift_instances where id = sb;

  perform set_config('test.boom', 'on', true);
  begin
    res := public.lensed_approve_shift_trade(A, t, date '2026-09-07');
    caught := 'NO ERROR (returned '||res::text||')';
  exception when others then
    caught := SQLERRM;
  end;
  perform set_config('test.boom', 'off', true);
  perform t_eq('post-swap fault: the error PROPAGATED (not swallowed into a refusal)',
    caught like 'BOOM%', true);
  perform t_eq('post-swap fault: A rolled back to Alice',
    (select i from public.shift_instances i where i.id = sa) is not distinct from before_a, true);
  perform t_eq('post-swap fault: B rolled back to Bob',
    (select i from public.shift_instances i where i.id = sb) is not distinct from before_b, true);
  perform t_eq('post-swap fault: trade still pending_manager',  (select status from public.shift_trades where id = t), 'pending_manager');
  perform t_eq('post-swap fault: zero attendance rows',         (select count(*)::int from public.attendance_events), 0);

  -- And with the fault cleared, the very same trade approves — nothing was consumed by the failure.
  perform t_eq('post-swap fault: recovers — approves once the fault is gone',
    (public.lensed_approve_shift_trade(A, t, date '2026-09-07'))->>'ok', 'true');
  perform t_eq('post-swap fault: A → Bob after recovery', (select employee_id from public.shift_instances where id=sa), bob);
end $$;

drop trigger if exists t_boom_attendance on public.attendance_events;
select t_report('atomicity');
