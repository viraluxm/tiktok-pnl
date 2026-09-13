-- lensed_apply_schedule_batch / lensed_assign_released_shift (migration 157): the manager WRITE
-- paths cannot create staffing above effective capacity.
--
-- THE RULE: a proposed row that would NEWLY occupy a setup inside an active block is refused when
-- the block is full. Everything else — removals, edits to someone already inside the block, any
-- team/date/span with no block — is untouched.
\set ON_ERROR_STOP on
set client_min_messages = notice;
set search_path = public;

\set OWNER   '''a0000000-0000-4000-8000-000000000001'''
\set NIGHT   '''b1000000-0000-4000-8000-000000000001'''
\set MORNING '''b2000000-0000-4000-8000-000000000002'''

-- A far-future Wednesday (2027-08-18 is a Wednesday), clear of every other suite's dates.
delete from shift_requests;
delete from shift_instances;
delete from shift_capacity_settings where block_id is not null;

-- Batch helper: build the planner's upsert shape for one host on one date.
create or replace function up(p_emp uuid, p_date date, p_start time, p_end time) returns jsonb
language sql as $$
  select jsonb_build_object(
    'employee_id', p_emp,
    'shift_date', p_date,
    'starts_at', (p_date + p_start) at time zone 'America/Los_Angeles',
    'ends_at', ((case when p_end <= p_start then p_date + 1 else p_date end) + p_end) at time zone 'America/Los_Angeles',
    'status', 'scheduled', 'source', 'admin_open',
    'shift_rule_id', null, 'store_id', null, 'role', 'host');
$$;

create or replace function batch(p_ups jsonb, p_del uuid[] default '{}', p_can uuid[] default '{}')
returns jsonb language sql as $$
  select public.lensed_apply_schedule_batch(
    'a0000000-0000-4000-8000-000000000001'::uuid, p_ups, p_del, p_can, '{"host":3,"fulfillment":0}'::jsonb);
$$;

-- ── 3. A TEAM WITH NO CAPACITY BLOCK IS UNAFFECTED ────────────────────────────────────────────
-- Frank is fulfillment; the seed has no fulfillment block. His row must land with no lock, no
-- recount and no refusal, however many of him there are.
do $$
declare res jsonb;
begin
  res := batch(jsonb_build_array(
    jsonb_build_object('employee_id','e6666666-0000-4000-8000-000000000006','shift_date',date '2027-08-18',
      'starts_at',(date '2027-08-18' + time '18:00') at time zone 'America/Los_Angeles',
      'ends_at',(date '2027-08-19' + time '02:00') at time zone 'America/Los_Angeles',
      'status','scheduled','source','admin_open','shift_rule_id',null,'store_id',null,'role','fulfillment')));
  perform t_eq('3. a fulfillment row is written with no capacity block in play', res->>'ok', 'true');
  perform t_eq('3. …and is not refused', jsonb_array_length(res->'refusals')::text, '0');
  perform t_eq('3. …and does not count against the HOST block',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '0');
end $$;

-- ── THE BASELINE: fill the night block to its team default of 3 ───────────────────────────────
do $$
declare res jsonb;
begin
  res := batch(jsonb_build_array(
    up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '18:00', time '02:00'),
    up('e2222222-0000-4000-8000-000000000002', date '2027-08-18', time '18:00', time '02:00'),
    up('e3333333-0000-4000-8000-000000000003', date '2027-08-18', time '18:00', time '02:00')));
  perform t_eq('baseline: three hosts scheduled in one batch', res->>'created', '3');
  perform t_eq('baseline: no refusals while there was room', jsonb_array_length(res->'refusals')::text, '0');
  perform t_eq('baseline: the block is full at 3 of 3',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');
end $$;

-- ── THE FOURTH IS REFUSED, AND ONLY THE FOURTH ────────────────────────────────────────────────
do $$
declare res jsonb; n int;
begin
  select count(*) into n from shift_instances;
  -- One row that fits (a different date) and one that does not (the full night).
  res := batch(jsonb_build_array(
    up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:00', time '02:00'),
    up('e7777777-0000-4000-8000-000000000007', date '2027-08-19', time '18:00', time '02:00')));
  perform t_eq('a full block refuses the addition', jsonb_array_length(res->'refusals')::text, '1');
  perform t_eq('…with OVER_CAPACITY', res->'refusals'->0->>'code', 'OVER_CAPACITY');
  perform t_eq('…naming the day that was full', res->'refusals'->0->>'shift_date', '2027-08-18');
  -- PARTIAL APPLICATION: the other day in the same batch still saved.
  perform t_eq('the day that fit still saved', res->>'created', '1');
  perform t_eq('exactly one row was added', (select count(*) from shift_instances)::text, (n + 1)::text);
  perform t_eq('the full block is still 3 of 3, never 4',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');
end $$;

-- ── 6. AN OFFERED SHIFT STILL COUNTS ──────────────────────────────────────────────────────────
do $$
declare res jsonb;
begin
  update shift_instances
     set offer_state = 'offered', offer_id = gen_random_uuid(), offered_at = now()
   where employee_id = 'e3333333-0000-4000-8000-000000000003' and shift_date = date '2027-08-18';
  perform t_eq('6. an offered shift is still staffed',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');
  res := batch(jsonb_build_array(up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:00', time '02:00')));
  perform t_eq('6. so the batch still refuses a fourth person while it is on the board',
    res->'refusals'->0->>'code', 'OVER_CAPACITY');
  update shift_instances set offer_state = null, offer_id = null, offered_at = null
   where employee_id = 'e3333333-0000-4000-8000-000000000003' and shift_date = date '2027-08-18';
end $$;

-- ── 7. OVERLAPPING SHIFTS RESPECT SIMULTANEOUS CAPACITY ───────────────────────────────────────
-- Nobody in the block matches its 18:00-02:00 window exactly, yet all three occupy a setup inside
-- it, so the fourth is still refused. Exact (start,end) grouping would have said the block was empty.
do $$
declare res jsonb;
begin
  delete from shift_instances where shift_date in (date '2027-08-18', date '2027-08-19');
  res := batch(jsonb_build_array(
    up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '17:00', time '01:00'),
    up('e2222222-0000-4000-8000-000000000002', date '2027-08-18', time '19:00', time '23:30'),
    up('e3333333-0000-4000-8000-000000000003', date '2027-08-18', time '20:00', time '04:00')));
  perform t_eq('7. three differently-timed shifts all occupy the 6pm block', res->>'created', '3');
  perform t_eq('7. the block counts all three', 
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');
  res := batch(jsonb_build_array(up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:30', time '21:00')));
  perform t_eq('7. a fourth overlapping shift is refused', res->'refusals'->0->>'code', 'OVER_CAPACITY');
  -- Half-open: a shift that ENDS exactly when the block starts does not overlap it.
  res := batch(jsonb_build_array(up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '10:00', time '18:00')));
  perform t_eq('7. a shift ending at 18:00 does NOT overlap a block starting at 18:00, so it saves',
    res->>'created', '1');
end $$;

-- ── 4 / 5. ALREADY OVER CAPACITY: KEEP EVERYONE, REFUSE ONLY NEW ADDITIONS ────────────────────
do $$
declare res jsonb; v_before int;
begin
  delete from shift_instances where shift_date = date '2027-08-18';
  -- Four people on the floor, then management drops the number to two.
  res := batch(jsonb_build_array(
    up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '18:00', time '02:00'),
    up('e2222222-0000-4000-8000-000000000002', date '2027-08-18', time '18:00', time '02:00'),
    up('e3333333-0000-4000-8000-000000000003', date '2027-08-18', time '18:00', time '02:00')));
  perform t_eq('4. three scheduled before the cut', res->>'created', '3');
  insert into shift_capacity_settings(user_id, team, block_id, date, capacity)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001', date '2027-08-18', 2);

  v_before := (select count(*) from shift_instances where shift_date = date '2027-08-18');
  -- 5. MOVING an existing worker inside the over-capacity block must still work.
  res := batch(jsonb_build_array(up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '19:00', time '03:00')));
  perform t_eq('5. an existing worker can still be re-timed while over capacity', res->>'updated', '1');
  perform t_eq('5. …and is not refused', jsonb_array_length(res->'refusals')::text, '0');
  perform t_eq('4. nobody was deleted or reassigned',
    (select count(*) from shift_instances where shift_date = date '2027-08-18')::text, v_before::text);
  perform t_eq('4. the floor is still over capacity, honestly',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');

  -- …but a NEW body is refused, because it worsens the overage.
  res := batch(jsonb_build_array(up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:00', time '02:00')));
  perform t_eq('4. a NEW addition is refused while over capacity', res->'refusals'->0->>'code', 'OVER_CAPACITY');

  -- 5. REMOVING a worker must always be possible, over capacity or not.
  res := batch('[]'::jsonb, array(select id from shift_instances
                 where shift_date = date '2027-08-18' and employee_id = 'e2222222-0000-4000-8000-000000000002'));
  perform t_eq('5. a worker can be removed', res->>'removed', '1');
  perform t_eq('5. …and the count falls',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '2');

  -- REMOVAL FREES A SPOT WITHIN THE SAME BATCH: the recount runs after the deletes.
  res := batch(
    jsonb_build_array(up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:00', time '02:00')),
    array(select id from shift_instances where shift_date = date '2027-08-18' and employee_id = 'e3333333-0000-4000-8000-000000000003'));
  perform t_eq('5. a batch that swaps one person for another succeeds', res->>'created', '1');
  perform t_eq('5. …and the count is unchanged',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '2');
  delete from shift_capacity_settings where block_id is not null;
end $$;

-- ── A SINGLE BATCH CANNOT SELF-OVERSUBSCRIBE ──────────────────────────────────────────────────
-- No concurrency needed: five rows in one call against a block of three.
do $$
declare res jsonb;
begin
  delete from shift_instances where shift_date = date '2027-08-18';
  res := batch(jsonb_build_array(
    up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '18:00', time '02:00'),
    up('e2222222-0000-4000-8000-000000000002', date '2027-08-18', time '18:00', time '02:00'),
    up('e3333333-0000-4000-8000-000000000003', date '2027-08-18', time '18:00', time '02:00'),
    up('e7777777-0000-4000-8000-000000000007', date '2027-08-18', time '18:00', time '02:00')));
  perform t_eq('one batch of four into a block of three writes three', res->>'created', '3');
  perform t_eq('…and refuses exactly one', jsonb_array_length(res->'refusals')::text, '1');
  perform t_eq('…leaving 3 of 3, never 4', 
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');
end $$;

-- ── CLOSED AVAILABILITY DOES NOT BLOCK A MANAGER ──────────────────────────────────────────────
-- "Close availability" stops employee REQUESTS. A manager scheduling someone directly is deliberate.
do $$
declare res jsonb;
begin
  delete from shift_instances where shift_date = date '2027-08-25';
  insert into shift_capacity_settings(user_id, team, block_id, date, closed)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001', date '2027-08-25', true);
  res := batch(jsonb_build_array(up('e1111111-0000-4000-8000-000000000001', date '2027-08-25', time '18:00', time '02:00')));
  perform t_eq('a closed day still accepts a direct manager write', res->>'created', '1');
  delete from shift_capacity_settings where block_id is not null;
end $$;

-- ── lensed_assign_released_shift: the legacy board is count-increasing and is gated too ───────
do $$
declare v_inst uuid; res jsonb;
begin
  delete from shift_instances where shift_date = date '2027-08-18';
  perform batch(jsonb_build_array(
    up('e1111111-0000-4000-8000-000000000001', date '2027-08-18', time '18:00', time '02:00'),
    up('e2222222-0000-4000-8000-000000000002', date '2027-08-18', time '18:00', time '02:00'),
    up('e3333333-0000-4000-8000-000000000003', date '2027-08-18', time '18:00', time '02:00')));
  -- A released row: no employee, so NOT staffed. Assigning someone adds a body to a full block.
  insert into shift_instances(user_id, employee_id, shift_date, starts_at, ends_at, status, source, released_at, role)
  values ('a0000000-0000-4000-8000-000000000001', null, date '2027-08-18',
          (date '2027-08-18' + time '18:00') at time zone 'America/Los_Angeles',
          (date '2027-08-19' + time '02:00') at time zone 'America/Los_Angeles',
          'released', 'admin_open', now(), 'host')
  returning id into v_inst;
  perform t_eq('a released row is NOT staffed',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');

  res := lensed_assign_released_shift('a0000000-0000-4000-8000-000000000001', v_inst,
                                      'e7777777-0000-4000-8000-000000000007', 3::smallint);
  perform t_eq('assigning it into a full block is refused', res->>'reason', 'NO_CAPACITY');
  perform t_eq('…and the row is untouched', (select status from shift_instances where id = v_inst), 'released');
  perform t_eq('…and the floor is still 3 of 3',
    staffed_in('a0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001', date '2027-08-18')::text, '3');

  -- Free a setup and it goes through, with the SAME CAS the pre-157 statement used.
  perform batch('[]'::jsonb, array(select id from shift_instances
                  where shift_date = date '2027-08-18' and employee_id = 'e3333333-0000-4000-8000-000000000003'));
  res := lensed_assign_released_shift('a0000000-0000-4000-8000-000000000001', v_inst,
                                      'e7777777-0000-4000-8000-000000000007', 3::smallint);
  perform t_eq('with room, the assignment succeeds', res->>'ok', 'true');
  perform t_eq('…the row is claimed by that employee',
    (select employee_id::text from shift_instances where id = v_inst), 'e7777777-0000-4000-8000-000000000007');
  perform t_eq('…released_at is cleared so the new owner can clock in',
    (select (released_at is null)::text from shift_instances where id = v_inst), 'true');
  -- Replay. ORDER MATTERS and this test pins it: capacity is checked BEFORE the CAS, exactly as
  -- 156's approval does, so with the block full again the replay reports NO_CAPACITY.
  res := lensed_assign_released_shift('a0000000-0000-4000-8000-000000000001', v_inst,
                                      'e1111111-0000-4000-8000-000000000001', 3::smallint);
  perform t_eq('a replay into a now-full block is refused for capacity first', res->>'reason', 'NO_CAPACITY');
  -- Free a setup so the CAS itself is what refuses: the row is no longer 'released'.
  perform batch('[]'::jsonb, array(select id from shift_instances
                  where shift_date = date '2027-08-18' and employee_id = 'e2222222-0000-4000-8000-000000000002'));
  res := lensed_assign_released_shift('a0000000-0000-4000-8000-000000000001', v_inst,
                                      'e1111111-0000-4000-8000-000000000001', 3::smallint);
  perform t_eq('with room, the replay loses the CAS instead of writing twice', res->>'reason', 'ALREADY_CLAIMED');
end $$;

-- ── OWNER ISOLATION ───────────────────────────────────────────────────────────────────────────
do $$
declare res jsonb;
begin
  -- Eve belongs to the OTHER tenant. Her row is dropped by the employees join, not written.
  res := public.lensed_apply_schedule_batch(
    'a0000000-0000-4000-8000-000000000001'::uuid,
    jsonb_build_array(up('e5555555-0000-4000-8000-000000000005', date '2027-09-01', time '18:00', time '02:00')),
    '{}', '{}', '{"host":3}'::jsonb);
  perform t_eq('a foreign employee is silently not written', res->>'created', '0');
  perform t_eq('…and no row exists for them',
    (select count(*) from shift_instances where employee_id = 'e5555555-0000-4000-8000-000000000005')::text, '0');
end $$;

-- ── HISTORICAL BEHAVIOUR ──────────────────────────────────────────────────────────────────────
do $$
begin
  perform t_eq('157 wrote nothing to shift_claims', (select count(*) from shift_claims)::text, '0');
  perform t_eq('157 wrote nothing to attendance_events', (select count(*) from attendance_events)::text, '0');
end $$;

select t_report('157 WRITE GUARD');
