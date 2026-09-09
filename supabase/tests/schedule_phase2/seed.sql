-- Deterministic roster. TWO owners so tenancy predicates are genuinely exercised, and one
-- 'former' employee so the active-employee gate has something real to reject.
insert into auth.users(id) values
  ('a0000000-0000-4000-8000-000000000001'),  -- owner A
  ('b0000000-0000-4000-8000-000000000002')   -- owner B (foreign tenant)
on conflict do nothing;

insert into public.employees(id, user_id, name, role, status, hourly_rate) values
  ('e1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Alice','host','active',20),
  ('e2222222-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','Bob','host','active',20),
  ('e3333333-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','Carol','host','active',20),
  ('e4444444-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','Dave','host','former',20),
  ('e5555555-0000-4000-8000-000000000005','b0000000-0000-4000-8000-000000000002','Eve','host','active',20)
on conflict do nothing;
