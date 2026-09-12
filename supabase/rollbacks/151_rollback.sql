-- Rollback for 151_bonus_target_date.sql
--
-- Apply as a single transaction: psql -1 -v ON_ERROR_STOP=1 -f 151_rollback.sql
-- NOT placed under supabase/migrations/ so nothing applies it by accident.
--
-- ⚠️ THIS DESTROYS THE DAY ON EVERY HOURLY BONUS, and a day-specific bonus without its day is not a
--    pay-period bonus — it is a row nothing can price. Export first:
--
--      select id, employee_id, period_start, period_end, calculation_type,
--             amount_cents, rate_cents_per_hour, target_date, description
--      from public.employee_pay_adjustments where calculation_type = 'hourly';
--
--    Rolling back with hourly rows present will ALSO fail at the 150 shape constraints the moment
--    anything writes them again, because the deployed code after 151 requires a target_date. Roll
--    the CODE back first, or delete the hourly rows knowingly, then run this.
--
-- FLAT BONUSES ARE UNAFFECTED in both directions — they carry target_date NULL either way.
-- NOTHING ELSE CHANGES: no shift, punch, break, confirmation, approved duration or hourly rate is
-- touched by this column's existence or by its removal.

begin;
set local lock_timeout = '3s';

alter table public.employee_pay_adjustments
  drop constraint if exists employee_pay_adjustments_target_date_in_period;
alter table public.employee_pay_adjustments
  drop constraint if exists employee_pay_adjustments_hourly_needs_target_date;
alter table public.employee_pay_adjustments
  drop constraint if exists employee_pay_adjustments_flat_no_target_date;

-- Only then — the constraints reference it.
alter table public.employee_pay_adjustments
  drop column if exists target_date;

commit;
