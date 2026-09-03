-- 118_pick_override_authorizer_name.sql
--
-- Snapshot WHO authorised a pick override, as text.
--
-- Two problems with relying on authorized_by_employee_id alone:
--
-- 1. It is `on delete set null`. Deleting an employee therefore ERASES who authorised every
--    override they ever granted — the rows survive but become anonymous. An audit trail that
--    forgets its subject when that subject leaves is not much of an audit trail, and leaving
--    is exactly when you might want to look.
--
-- 2. The owner is not an employee. There is no row in `employees` for the account holder
--    (checked: zero), and adding one would put them in payroll, because computePay takes the
--    whole employees list. So an owner-authorised override has no employee_id to record, and
--    a NULL would be indistinguishable from "we do not know".
--
-- A name snapshot fixes both, and follows the pattern already used on the pick path:
-- shipment_verifications stores picker_name_snapshot for the same reason.
--
-- Reading the two columns together tells you which kind of authorisation happened:
--   employee_id set   + name set  -> a lead, by PIN
--   employee_id NULL  + name set  -> the owner, by account password
--   employee_id NULL  + name NULL -> a pre-118 row, before this was recorded
--
-- APPLY GATE — Class A. Adds one nullable column with no default to pick_overrides, a table
-- created hours ago that nothing deployed reads and which holds no rows. Catalog-only in
-- PG11+, so the ACCESS EXCLUSIVE lock is momentary. Own transaction, lock_timeout = '3s'.

alter table public.pick_overrides
  add column if not exists authorized_by_name text;
