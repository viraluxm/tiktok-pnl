-- 156_rollback.sql — reverse 156_shift_capacity_blocks.sql.
--
-- ⚠️ NOT APPLIED (156 itself is not applied either). Lives OUTSIDE supabase/migrations/ so it can
--    never be picked up as a migration — the same placement as 150_rollback.sql.
--
-- SAFE BY CONSTRUCTION: 156 created three EMPTY tables, one function and one index, and altered
-- nothing that existed before. Dropping them restores the pre-156 catalog exactly.
--
-- WHAT IS **NOT** ROLLED BACK, on purpose: shift_instances rows created by an approved request.
-- Those are real shifts real people are scheduled to work. They carry source='admin_open' and a
-- role, are indistinguishable from a manager-posted one-time shift, and remain valid with no
-- capacity tables present. Deleting them here would silently un-schedule staff.
--
-- To find them after a rollback (they are the only admin_open rows with shift_rule_id IS NULL that
-- were created in the feature's window):
--   select id, employee_id, shift_date, starts_at, ends_at from public.shift_instances
--    where source = 'admin_open' and created_at >= '<when 156 was applied>';

begin;
set local lock_timeout = '3s';

drop function if exists public.lensed_approve_shift_request(uuid, uuid, smallint);

commit;

begin;
set local lock_timeout = '3s';

-- shift_requests first: it FKs both of the others.
drop table if exists public.shift_requests;
drop table if exists public.shift_capacity_settings;
drop table if exists public.shift_capacity_blocks;

commit;

begin;
set local lock_timeout = '3s';

drop index if exists public.idx_shift_instances_owner_span;

commit;
