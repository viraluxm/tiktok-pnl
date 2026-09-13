-- Capacity fixtures, layered on top of ../schedule_phase2/seed.sql (owners A and B, hosts
-- Alice/Bob/Carol, FORMER Dave, and Eve who belongs to the OTHER tenant).
--
-- One fulfillment employee is added so the same-team predicate has something real to reject, and
-- one host whose role is spelled 'Live Host' so the trim+lower mapping is genuinely exercised.

insert into public.employees(id, user_id, name, role, status, hourly_rate) values
  ('e6666666-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','Frank','fulfillment','active',20),
  ('e7777777-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','Gina',' Live Host ','active',20)
on conflict do nothing;

-- Two staffing blocks for owner A, both Live Host, covering the same weekdays:
--   NIGHT   18:00 → 02:00 (overnight)
--   MORNING 06:00 → 14:00
-- and one for the OTHER tenant, so an owner-scoped read has something it must not see.
insert into public.shift_capacity_blocks
  (id, user_id, team, label, days_of_week, start_time, end_time, capacity, active) values
  ('b1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','host','Night',
   array[0,1,2,3,4,5,6]::smallint[], '18:00', '02:00', null, true),
  ('b2000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','host','Morning',
   array[1,2,3,4,5]::smallint[], '06:00', '14:00', null, true),
  ('b3000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','host','Paused',
   array[0,1,2,3,4,5,6]::smallint[], '10:00', '18:00', null, false),
  ('b9000000-0000-4000-8000-000000000009','b0000000-0000-4000-8000-000000000002','host','Foreign',
   array[0,1,2,3,4,5,6]::smallint[], '18:00', '02:00', null, true)
on conflict do nothing;

-- Owner A's team default: three Live Host setups. Small on purpose — every state is reachable
-- with the three hosts the shared seed provides.
insert into public.shift_capacity_settings(id, user_id, team, block_id, date, capacity, closed) values
  ('c1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','host', null, null, 3, false)
on conflict do nothing;
