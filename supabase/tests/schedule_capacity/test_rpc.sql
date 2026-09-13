-- lensed_approve_shift_request: the happy path, every refusal, and the invariants that make the
-- refusals meaningful (nothing written, nothing mutated).
--
-- THE ONE RULE: a request that was legal when it was FILED may be illegal when it is APPROVED.
-- Every precondition is therefore re-checked here, under the advisory lock, against current state.
\set ON_ERROR_STOP on
set client_min_messages = notice;
set search_path = public;

\set OWNER   '''a0000000-0000-4000-8000-000000000001'''
\set OWNER_B '''b0000000-0000-4000-8000-000000000002'''
\set NIGHT   '''b1000000-0000-4000-8000-000000000001'''
\set MORNING '''b2000000-0000-4000-8000-000000000002'''
\set PAUSED  '''b3000000-0000-4000-8000-000000000003'''
\set ALICE   '''e1111111-0000-4000-8000-000000000001'''
\set BOB     '''e2222222-0000-4000-8000-000000000002'''
\set CAROL   '''e3333333-0000-4000-8000-000000000003'''
\set DAVE    '''e4444444-0000-4000-8000-000000000004'''
\set EVE     '''e5555555-0000-4000-8000-000000000005'''
\set FRANK   '''e6666666-0000-4000-8000-000000000006'''
\set GINA    '''e7777777-0000-4000-8000-000000000007'''

-- A far-future Wednesday, so "past date" is never accidentally true.
\set D '''2027-06-16'''

delete from shift_requests;
delete from shift_instances;

-- ── HAPPY PATH ────────────────────────────────────────────────────────────────────────────────
-- Team default 3, nobody scheduled. Alice requests the night block.
do $$
declare r uuid; res jsonb; si public.shift_instances;
begin
  r := mkreq('e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16');
  res := lensed_approve_shift_request('a0000000-0000-4000-8000-000000000001', r, 3::smallint);
  perform t_eq('approve: ok', res->>'ok', 'true');
  perform t_eq('approve: reported the staffing it decided against', res->>'staffed_before', '0');
  perform t_eq('approve: reported the capacity it decided against', res->>'capacity', '3');
  select * into si from shift_instances where id = (res->>'shift_instance_id')::uuid;
  perform t_eq('approve: created ONE shift for the requester', si.employee_id::text, 'e1111111-0000-4000-8000-000000000001');
  perform t_eq('approve: the shift is scheduled', si.status, 'scheduled');
  perform t_eq('approve: source is admin_open — a manager put it here', si.source, 'admin_open');
  perform t_eq('approve: shift_rule_id is NULL so the materializer never touches it', si.shift_rule_id::text, null);
  perform t_eq('approve: the row carries its own role', si.role, 'host');
  perform t_eq('approve: the span is the block window, recomputed server-side',
    (si.starts_at = (select starts_at from blk_span('b1000000-0000-4000-8000-000000000001', date '2027-06-16')))::text, 'true');
  perform t_eq('approve: the request is linked to the shift it created',
    (select shift_instance_id from shift_requests where id = r)::text, si.id::text);
  perform t_eq('approve: the request is approved', (select status from shift_requests where id = r), 'approved');
  -- NO attendance_events row: nothing was released, so a bare 'claimed' event would forgive a drop.
  perform t_eq('approve: writes NO attendance event (a new shift has no outgoing person)',
    (select count(*) from attendance_events)::text, '0');
  -- 10. approval consumed exactly one available shift.
  perform t_eq('approve: staffing rose by exactly one',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16')::text, '1');
end $$;

-- ── REPLAY ────────────────────────────────────────────────────────────────────────────────────
do $$
declare r uuid;
begin
  select id into r from shift_requests where status = 'approved' limit 1;
  perform t_refuse_req('replay: an approved request reports ALREADY_APPROVED, writes nothing',
    'a0000000-0000-4000-8000-000000000001', r, 'ALREADY_APPROVED');
end $$;

-- ── 11 / NO_CAPACITY: the last shift cannot be approved twice ─────────────────────────────────
do $$
declare rb uuid; rc uuid; res jsonb;
begin
  -- Alice already holds one of the three. Bob and Carol both request; both may be pending.
  rb := mkreq('e2222222-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001', date '2027-06-16');
  rc := mkreq('e3333333-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000001', date '2027-06-16');
  perform t_eq('pending requests do NOT consume capacity — still 1 staffed of 3',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16')::text, '1');
  res := lensed_approve_shift_request('a0000000-0000-4000-8000-000000000001', rb, 3::smallint);
  perform t_eq('approve Bob: ok', res->>'ok', 'true');
  res := lensed_approve_shift_request('a0000000-0000-4000-8000-000000000001', rc, 3::smallint);
  perform t_eq('approve Carol: ok (the third and last)', res->>'ok', 'true');
  perform t_eq('the block is now full at 3 of 3',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16')::text, '3');
end $$;

do $$
declare rg uuid;
begin
  -- Gina (' Live Host ') requests a FULL block. The trim+lower mapping puts her on the host team,
  -- so she is refused for capacity — not silently let through as 'other'.
  rg := mkreq('e7777777-0000-4000-8000-000000000007','b1000000-0000-4000-8000-000000000001', date '2027-06-16');
  perform t_refuse_req('NO_CAPACITY: a full block refuses rather than oversubscribing',
    'a0000000-0000-4000-8000-000000000001', rg, 'NO_CAPACITY');
end $$;

-- ── 15 / 16. A COWORKER-OFFERED SHIFT DOES NOT FREE A SETUP ───────────────────────────────────
do $$
declare rg uuid; before_n int;
begin
  before_n := staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16');
  -- Carol drops her shift: still hers, still active, now on the pickup board.
  update shift_instances
     set offer_state = 'offered', offer_id = gen_random_uuid(), offered_at = now()
   where employee_id = 'e3333333-0000-4000-8000-000000000003' and shift_date = date '2027-06-16';
  perform t_eq('offered: the shift is STILL owned by the offerer',
    (select (employee_id is not null and status in ('scheduled','claimed'))::text from shift_instances
      where employee_id = 'e3333333-0000-4000-8000-000000000003' and shift_date = date '2027-06-16'), 'true');
  perform t_eq('offered: the staffed count is UNCHANGED — no 4th spot appears',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-16')::text, before_n::text);
  select id into rg from shift_requests where employee_id = 'e7777777-0000-4000-8000-000000000007' and status = 'pending' limit 1;
  perform t_refuse_req('offered: a capacity request is still refused while the offer is open',
    'a0000000-0000-4000-8000-000000000001', rg, 'NO_CAPACITY');
  update shift_instances set offer_state = null, offer_id = null, offered_at = null
   where employee_id = 'e3333333-0000-4000-8000-000000000003' and shift_date = date '2027-06-16';
end $$;

-- ── 6. Morning and night are counted SEPARATELY ───────────────────────────────────────────────
do $$
declare rg uuid; res jsonb;
begin
  perform t_eq('the morning block on the same date is still empty',
    staffed_in('a0000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002', date '2027-06-16')::text, '0');
  -- Gina's night request is refused for capacity, but the same person on the MORNING block is not…
  select id into rg from shift_requests where employee_id = 'e7777777-0000-4000-8000-000000000007' and status = 'pending' limit 1;
  update shift_requests set status = 'withdrawn' where id = rg;
  rg := mkreq('e7777777-0000-4000-8000-000000000007','b2000000-0000-4000-8000-000000000002', date '2027-06-16');
  res := lensed_approve_shift_request('a0000000-0000-4000-8000-000000000001', rg, 3::smallint);
  perform t_eq('a full NIGHT block does not close the MORNING block', res->>'ok', 'true');
  perform t_eq('morning is now 1 of 3',
    staffed_in('a0000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002', date '2027-06-16')::text, '1');
end $$;

-- ── 14. EMPLOYEE_DOUBLE_BOOKED — UNIQUE(employee_id, shift_date) is the backstop ──────────────
--
-- ORDERING NOTE, learned from this test failing the first time: on 2027-06-16 the night block was
-- already FULL, so the capacity recount refused before the insert could ever trip the unique
-- constraint. That ordering is correct — capacity is the blocking invariant and must be checked
-- first — so the double-booking backstop needs a date where the block genuinely HAS room.
do $$
declare r uuid;
begin
  -- Gina works the morning of the 25th (06:00–14:00, which does not overlap the night block), and
  -- the night block that day is empty. Capacity is available; the person is not.
  perform mkspan('e7777777-0000-4000-8000-000000000007', date '2027-06-25', time '06:00', time '14:00');
  perform t_eq('double-booked setup: the night block genuinely has room that day',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-25')::text, '0');
  r := mkreq('e7777777-0000-4000-8000-000000000007','b1000000-0000-4000-8000-000000000001', date '2027-06-25');
  perform t_refuse_req('DOUBLE_BOOKED: one shift per person per day, surfaced as a clean refusal',
    'a0000000-0000-4000-8000-000000000001', r, 'EMPLOYEE_DOUBLE_BOOKED');
  update shift_requests set status = 'withdrawn' where id = r;
end $$;

-- ── The remaining refusals, each on its own date so they cannot interfere ─────────────────────
do $$
declare r uuid;
begin
  -- 21. an inactive block produces no opportunity, and no approval either.
  r := mkreq('e1111111-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000003', date '2027-06-17');
  perform t_refuse_req('BLOCK_INACTIVE: a paused block cannot be approved into',
    'a0000000-0000-4000-8000-000000000001', r, 'BLOCK_INACTIVE');
  update shift_requests set status='withdrawn' where id=r;

  -- BLOCK_NOT_ON_DATE: the morning block does not run on Sundays.
  r := mkreq('e1111111-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002', date '2027-06-20');
  perform t_refuse_req('BLOCK_NOT_ON_DATE: a weekday the block no longer runs is refused',
    'a0000000-0000-4000-8000-000000000001', r, 'BLOCK_NOT_ON_DATE');
  update shift_requests set status='withdrawn' where id=r;

  -- 18. Close availability.
  r := mkreq('e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-18');
  insert into shift_capacity_settings(user_id,team,block_id,date,closed)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001', date '2027-06-18', true);
  perform t_refuse_req('AVAILABILITY_CLOSED: a closed day refuses, and cancels nothing',
    'a0000000-0000-4000-8000-000000000001', r, 'AVAILABILITY_CLOSED');
  -- 19. Closing availability must not have touched a single assignment.
  perform t_eq('closing availability cancelled no scheduled shift',
    (select count(*) from shift_instances where status <> 'scheduled')::text, '0');
  delete from shift_capacity_settings where date = date '2027-06-18';
  update shift_requests set status='withdrawn' where id=r;

  -- 17. A date override of 0 is "no more, today" without closing.
  r := mkreq('e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-19');
  insert into shift_capacity_settings(user_id,team,block_id,date,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001', date '2027-06-19', 0);
  perform t_refuse_req('date override 0: refused for capacity, not for closure',
    'a0000000-0000-4000-8000-000000000001', r, 'NO_CAPACITY');
  delete from shift_capacity_settings where date = date '2027-06-19';
  update shift_requests set status='withdrawn' where id=r;

  -- STALE_BLOCK: the block's hours moved after the request was filed (the ABA guard).
  r := mkreq('e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-21');
  update shift_capacity_blocks set start_time = '17:00' where id = 'b1000000-0000-4000-8000-000000000001';
  perform t_refuse_req('STALE_BLOCK: edited hours refuse rather than creating a different shift',
    'a0000000-0000-4000-8000-000000000001', r, 'STALE_BLOCK');
  update shift_capacity_blocks set start_time = '18:00' where id = 'b1000000-0000-4000-8000-000000000001';
  update shift_requests set status='withdrawn' where id=r;

  -- EMPLOYEE_UNAVAILABLE: Dave is 'former'. His permanent token still resolves, so this matters.
  r := mkreq('e4444444-0000-4000-8000-000000000004','b1000000-0000-4000-8000-000000000001', date '2027-06-22');
  perform t_refuse_req('EMPLOYEE_UNAVAILABLE: a former employee cannot be approved',
    'a0000000-0000-4000-8000-000000000001', r, 'EMPLOYEE_UNAVAILABLE');
  update shift_requests set status='withdrawn' where id=r;

  -- WRONG_TEAM: Frank is fulfillment; the block is Live Host.
  r := mkreq('e6666666-0000-4000-8000-000000000006','b1000000-0000-4000-8000-000000000001', date '2027-06-23');
  perform t_refuse_req('WRONG_TEAM: team comes from employees.role, and it is checked at approval',
    'a0000000-0000-4000-8000-000000000001', r, 'WRONG_TEAM');
  update shift_requests set status='withdrawn' where id=r;

  -- PAST_DATE.
  insert into shift_requests(id,user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('dfaaaaaa-0000-4000-8000-0000000000aa','a0000000-0000-4000-8000-000000000001',
            'e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
            date '2020-01-01','2020-01-02 02:00Z','2020-01-02 10:00Z','host');
  perform t_refuse_req('PAST_DATE: a day that has gone cannot be approved',
    'a0000000-0000-4000-8000-000000000001', 'dfaaaaaa-0000-4000-8000-0000000000aa', 'PAST_DATE');
end $$;

-- ── 8. OWNER ISOLATION ────────────────────────────────────────────────────────────────────────
do $$
declare r uuid;
begin
  r := mkreq('e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-06-24');
  -- The OTHER tenant passing our request id must learn nothing and change nothing.
  perform t_refuse_req('owner isolation: a foreign owner sees REQUEST_NOT_FOUND, indistinguishable from missing',
    'b0000000-0000-4000-8000-000000000002', r, 'REQUEST_NOT_FOUND');
  perform t_eq('owner isolation: the request is still pending',
    (select status from shift_requests where id = r), 'pending');
  update shift_requests set status='withdrawn' where id=r;
  perform t_refuse_req('a random uuid is REQUEST_NOT_FOUND, not an error',
    'a0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'REQUEST_NOT_FOUND');
end $$;

-- ── 22. HISTORICAL BEHAVIOUR UNCHANGED ────────────────────────────────────────────────────────
do $$
begin
  perform t_eq('156 wrote nothing to shift_claims', (select count(*) from shift_claims)::text, '0');
  perform t_eq('156 wrote nothing to attendance_events', (select count(*) from attendance_events)::text, '0');
  -- Every shift the RPC created carries source='admin_open'. (The fixture shifts mkspan() seeds
  -- default to 'pattern', which is exactly how a real materialized shift looks — they are here to
  -- be COUNTED against capacity, not created by an approval.)
  perform t_eq('every shift an approval created is source=admin_open',
    (select count(*) from shift_instances si join shift_requests r on r.shift_instance_id = si.id
      where si.source <> 'admin_open')::text, '0');
end $$;

select t_report('156 RPC');
