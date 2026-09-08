-- lensed_approve_shift_trade: happy path (two days, and the same day), replay, every refusal path.
-- Every refusal goes through t_refuse_trade, which also proves NOTHING moved.
\set QUIET on
set client_min_messages = notice;
delete from public.attendance_events;
delete from public.shift_trades;
delete from public.shift_claims;
delete from public.shift_instances;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- HAPPY PATH — Alice's Tuesday for Bob's Thursday
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  pp date := date '2026-09-07';
  sa uuid; sb uuid; t uuid; res jsonb; ia public.shift_instances; ib public.shift_instances;
begin
  sa := mk(alice, '2027-01-05');           -- Alice's shift → should go to Bob
  sb := mk(bob,   '2027-01-07', 'claimed'); -- Bob's shift → should go to Alice (a claimed row is tradeable too)
  t := mkt(alice, sa, bob, sb);

  res := public.lensed_approve_shift_trade(A, t, pp);
  perform t_eq('happy: ok',                         res->>'ok', 'true');
  perform t_eq('happy: requester now has B',        res->>'requester_now_has', sb::text);
  perform t_eq('happy: target now has A',           res->>'target_now_has', sa::text);
  perform t_eq('happy: 4 attendance events',        res->>'attendance_events', '4');

  select * into ia from public.shift_instances where id = sa;
  select * into ib from public.shift_instances where id = sb;
  perform t_eq('happy: A → Bob',                    ia.employee_id, bob);
  perform t_eq('happy: B → Alice',                  ib.employee_id, alice);
  perform t_eq('happy: both status claimed',        ia.status||'/'||ib.status, 'claimed/claimed');
  perform t_eq('happy: both source claim',          ia.source||'/'||ib.source, 'claim/claim');
  perform t_eq('happy: released_at stays NULL',     (ia.released_at is null and ib.released_at is null), true);
  perform t_eq('happy: dates untouched',            ia.shift_date::text||'/'||ib.shift_date::text, '2027-01-05/2027-01-07');
  -- The new owners must be able to clock in (CLOCK_ELIGIBLE_STATUSES + released_at NULL).
  perform t_eq('happy: both clock-eligible',
    (ia.status in ('scheduled','claimed') and ia.released_at is null and ib.status in ('scheduled','claimed') and ib.released_at is null), true);

  perform t_eq('happy: trade approved',             (select status from public.shift_trades where id = t), 'approved');
  perform t_eq('happy: decided_by = owner',         (select decided_by from public.shift_trades where id = t), A);
  perform t_eq('happy: decided_at set',             (select decided_at is not null from public.shift_trades where id = t), true);

  -- Attendance: the pickup pair, for BOTH sides, in the caller's pay period.
  perform t_eq('attendance: Alice released A',
    (select count(*)::int from public.attendance_events where employee_id=alice and shift_instance_id=sa and event_type='released' and pay_period_start=pp), 1);
  perform t_eq('attendance: Bob claimed A',
    (select count(*)::int from public.attendance_events where employee_id=bob and shift_instance_id=sa and event_type='claimed' and pay_period_start=pp), 1);
  perform t_eq('attendance: Bob released B',
    (select count(*)::int from public.attendance_events where employee_id=bob and shift_instance_id=sb and event_type='released' and pay_period_start=pp), 1);
  perform t_eq('attendance: Alice claimed B',
    (select count(*)::int from public.attendance_events where employee_id=alice and shift_instance_id=sb and event_type='claimed' and pay_period_start=pp), 1);
  perform t_eq('attendance: exactly four rows', (select count(*)::int from public.attendance_events), 4);
  -- drops = max(0, releases − claims) per employee → each nets to ZERO.
  perform t_eq('drops: Alice nets to zero',
    (select greatest(0, count(*) filter (where event_type='released') - count(*) filter (where event_type='claimed'))::int
       from public.attendance_events where employee_id=alice and pay_period_start=pp), 0);
  perform t_eq('drops: Bob nets to zero',
    (select greatest(0, count(*) filter (where event_type='released') - count(*) filter (where event_type='claimed'))::int
       from public.attendance_events where employee_id=bob and pay_period_start=pp), 0);
  -- The materializer guard key (employee, old date) now carries a 'released' row for each side.
  perform t_eq('guard: (Alice, 2027-01-05) has a released row',
    (select count(*)::int from public.attendance_events where employee_id=alice and shift_date='2027-01-05' and event_type='released'), 1);
  perform t_eq('guard: (Bob, 2027-01-07) has a released row',
    (select count(*)::int from public.attendance_events where employee_id=bob and shift_date='2027-01-07' and event_type='released'), 1);
  -- No payroll row, ever.
  perform t_eq('payroll: no shifts row written', (select count(*)::int from public.shifts), 0);

  -- ═══ REPLAY ═══
  res := public.lensed_approve_shift_trade(A, t, pp);
  perform t_eq('replay: refused',            res->>'ok', 'false');
  perform t_eq('replay: ALREADY_APPROVED',   res->>'reason', 'ALREADY_APPROVED');
  perform t_eq('replay: still 4 events',     (select count(*)::int from public.attendance_events), 4);
  perform t_eq('replay: A still Bob''s',     (select employee_id from public.shift_instances where id=sa), bob);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SAME-DAY SWAP — the case a single UPDATE would trip UNIQUE(employee_id, shift_date) on
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  sa uuid; sb uuid; t uuid; res jsonb;
begin
  delete from public.attendance_events; delete from public.shift_trades; delete from public.shift_instances;
  sa := mk(alice, '2027-02-01');
  sb := mk(bob,   '2027-02-01');
  t := mkt(alice, sa, bob, sb);
  res := public.lensed_approve_shift_trade(A, t, date '2026-09-07');
  perform t_eq('same-day: ok',        res->>'ok', 'true');
  perform t_eq('same-day: A → Bob',   (select employee_id from public.shift_instances where id=sa), bob);
  perform t_eq('same-day: B → Alice', (select employee_id from public.shift_instances where id=sb), alice);
  perform t_eq('same-day: UNIQUE(employee_id, shift_date) still holds (one row each that day)',
    (select count(*)::int from (select employee_id, shift_date from public.shift_instances group by 1,2 having count(*) > 1) d), 0);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- REFUSALS — each one leaves the world exactly as it found it
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  B     uuid := 'b0000000-0000-4000-8000-000000000002';   -- foreign tenant
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  carol uuid := 'e3333333-0000-4000-8000-000000000003';
  dave  uuid := 'e4444444-0000-4000-8000-000000000004';   -- former
  eve   uuid := 'e5555555-0000-4000-8000-000000000005';   -- owner B
  frank uuid := 'e6666666-0000-4000-8000-000000000006';   -- fulfillment
  sa uuid; sb uuid; sc uuid; se uuid; sf uuid; t uuid; t2 uuid; o uuid;
begin
  delete from public.attendance_events; delete from public.shift_trades; delete from public.shift_instances;
  sa := mk(alice, '2027-03-01');
  sb := mk(bob,   '2027-03-03');

  -- Not pending for sa manager yet.
  t := mkt(alice, sa, bob, sb, 'pending_coworker', null);
  perform t_refuse_trade('refuse: still waiting for the coworker', A, t, 'TRADE_NOT_PENDING');
  update public.shift_trades set status='declined', coworker_response='declined', coworker_responded_at=now() where id=t;
  perform t_refuse_trade('refuse: declined trade', A, t, 'TRADE_NOT_PENDING');
  update public.shift_trades set status='cancelled', coworker_response=null, cancelled_at=now() where id=t;
  perform t_refuse_trade('refuse: cancelled trade', A, t, 'TRADE_NOT_PENDING');
  delete from public.shift_trades;

  -- Wrong owner / unknown id.
  t := mkt(alice, sa, bob, sb);
  perform t_refuse_trade('refuse: another owner cannot approve it', B, t, 'TRADE_NOT_FOUND');
  perform t_refuse_trade('refuse: unknown trade id', A, gen_random_uuid(), 'TRADE_NOT_FOUND');

  -- Ownership moved under the trade.
  update public.shift_instances set employee_id = carol where id = sa;
  perform t_refuse_trade('refuse: requester no longer owns their shift', A, t, 'REQUESTER_NO_LONGER_OWNS');
  update public.shift_instances set employee_id = alice where id = sa;
  update public.shift_instances set employee_id = carol where id = sb;
  perform t_refuse_trade('refuse: target no longer owns their shift', A, t, 'TARGET_NO_LONGER_OWNS');
  update public.shift_instances set employee_id = bob where id = sb;

  -- Shift state.
  update public.shift_instances set status = 'cancelled' where id = sa;
  perform t_refuse_trade('refuse: sa cancelled shift', A, t, 'SHIFT_NOT_ACTIVE');
  update public.shift_instances set status = 'scheduled' where id = sa;
  update public.shift_instances set released_at = now() where id = sb;
  perform t_refuse_trade('refuse: sa legacy-released shift', A, t, 'SHIFT_RELEASED');
  update public.shift_instances set released_at = null where id = sb;
  o := gen_random_uuid();
  update public.shift_instances set offer_state='offered', offer_id=o, offered_at=now() where id = sa;
  perform t_refuse_trade('refuse: an OFFERED shift (resolve the offer first)', A, t, 'SHIFT_OFFERED');
  update public.shift_instances set offer_state=null, offer_id=null, offered_at=null where id = sa;
  update public.shift_instances set starts_at = now() - interval '1 hour', ends_at = now() + interval '7 hours' where id = sb;
  perform t_refuse_trade('refuse: sa shift that already started', A, t, 'ALREADY_STARTED');
  update public.shift_instances set starts_at = '2027-03-03 09:00', ends_at = '2027-03-03 17:00' where id = sb;

  -- People.
  update public.employees set status = 'former' where id = bob;
  perform t_refuse_trade('refuse: target no longer active', A, t, 'EMPLOYEE_UNAVAILABLE');
  update public.employees set status = 'active' where id = bob;
  update public.employees set role = 'fulfillment' where id = bob;
  perform t_refuse_trade('refuse: roles differ (host ↔ fulfillment)', A, t, 'ROLE_MISMATCH');
  update public.employees set role = 'host' where id = bob;
  update public.shift_instances set role = 'fulfillment' where id = sa;
  perform t_refuse_trade('refuse: sa row role that disagrees with the people', A, t, 'ROLE_MISMATCH');
  update public.shift_instances set role = null where id = sa;

  -- A second live trade touching one of the shifts (the cross-column case).
  sc := mk(carol, '2027-03-05');
  t2 := mkt(bob, sb, carol, sc, 'pending_coworker', null);   -- Bob offers B (target side of t) to Carol
  perform t_refuse_trade('refuse: another pending trade involves shift B', A, t, 'CONFLICTING_TRADE');
  update public.shift_trades set status='cancelled', cancelled_at=now() where id = t2;

  -- Cross-tenant: the trade names Eve's shift (owner B). The owner-scoped read simply does not find it.
  se := mk(eve, '2027-03-07', 'scheduled', null, null, null, null, B);
  t2 := mkt(carol, sc, eve, se, 'pending_manager', 'accepted', A);
  perform t_refuse_trade('refuse: sa foreign-tenant shift is not found', A, t2, 'SHIFT_NOT_FOUND');
  update public.shift_trades set status='cancelled', cancelled_at=now() where id = t2;

  -- After all that abuse the ORIGINAL trade still approves cleanly — proving the refusals wrote nothing.
  perform t_eq('after refusals: the untouched trade approves',
    (public.lensed_approve_shift_trade(A, t, date '2026-09-07'))->>'ok', 'true');
  perform t_eq('after refusals: A → Bob', (select employee_id from public.shift_instances where id=sa), bob);
  perform t_eq('after refusals: B → Alice', (select employee_id from public.shift_instances where id=sb), alice);
end $$;

select t_report('lensed_approve_shift_trade');
