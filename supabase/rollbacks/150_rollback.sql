-- Rollback for 150_employee_pay_adjustments.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 150_rollback.sql
-- NOT placed under supabase/migrations/ so nothing applies it by accident.
--
-- ⚠️ THIS DESTROYS MONEY OWED. Every bonus a manager has entered lives in this table and nowhere
--    else — there is no second copy and no derivation that could rebuild it. Export first:
--
--      select id, user_id, employee_id, period_start, period_end, amount_cents, description,
--             created_at, updated_at
--      from public.employee_pay_adjustments order by created_at;
--
-- EFFECT OF ROLLING BACK: Total Owed on the Pay tab, in Pay Details and on the PDF returns to
-- worked pay alone. NOTHING ELSE CHANGES — no shift, punch, break, confirmation, approved duration
-- or hourly rate is touched by this table's existence or by its removal, which is the whole point
-- of having made a bonus a separate row.
--
-- ORDER MATTERS: the table must go before the index it depends on, or the drop fails on the FK.

begin;
set local lock_timeout = '3s';

drop table if exists public.employee_pay_adjustments;

-- Only then. Harmless to keep (it is a trivially-unique index on a small roster table) — drop it
-- only if you want the schema back exactly as it was before 150.
drop index if exists public.uq_employees_id_user;

commit;
