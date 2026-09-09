-- Extends ../schedule_phase2/seed.sql (Alice/Bob/Carol host active, Dave former, Eve owner B)
-- with one FULFILLMENT employee so ROLE_MISMATCH has a real subject.
insert into public.employees(id, user_id, name, role, status, hourly_rate) values
  ('e6666666-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','Frank','fulfillment','active',20)
on conflict do nothing;
