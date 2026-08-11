-- 090_shift_instances_admin_open.sql
-- One-time admin shifts on shift_instances (assigned or unassigned-to-the-board). Adds the
-- `admin_open` source, plus a `role` and `note` column an admin shift needs.
--
-- ⚠️ MIGRATION LEDGER: this DB has NO ledger — migrations are hand-applied and the repo file is the
--    only record. Prefix 090 was chosen above the highest known (085/086 scheduling; 087
--    member_inventory_reorder_read; 088 capture_health_alerts; 089 member_pnl_read — all present on
--    branches, some applied). ➜ Inspect the LIVE schema before hand-applying; DB state is UNVERIFIED.
--    Fully idempotent (guarded do-blocks + if-not-exists); safe to re-run.
--
-- WHY role + note: for a pattern/claim instance, role is DERIVED from the employee (rule owner or
-- claimer). An admin UNASSIGNED open shift has employee_id NULL and released_by NULL — no employee
-- to derive from — so it must carry its own role. note is the optional "extra Saturday coverage" text.
--
-- WHY NO "employee_id NULL ⇒ role NOT NULL" CHECK: a RELEASED pattern instance legitimately has
-- employee_id NULL *and* role NULL (its role derives from released_by). A bare check would reject
-- every release. The correct invariant — a row can always determine its role — is
-- (employee_id IS NOT NULL OR released_by IS NOT NULL OR role IS NOT NULL), but per the design
-- decision we enforce "unassigned admin_open ⇒ role required" in the INSERT PATH (the admin route)
-- rather than a DB check, keeping the release path untouched. Documented here so it's not re-litigated.

begin;

-- 1. source: allow 'admin_open' (one-time admin shift; shift_rule_id stays NULL so the forward
--    materializer never regenerates or touches it — it keys only on active shift_rules).
alter table public.shift_instances drop constraint if exists shift_instances_source_check;
alter table public.shift_instances
  add constraint shift_instances_source_check check (source in ('pattern', 'claim', 'admin_open'));

-- 2. role — the pay-role class an admin shift carries (NULL for pattern/claim, where it's derived).
alter table public.shift_instances add column if not exists role text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shift_instances_role_check') then
    alter table public.shift_instances
      add constraint shift_instances_role_check check (role is null or role in ('host', 'fulfillment'));
  end if;
end $$;

-- 3. note — optional free text ("extra Saturday coverage").
alter table public.shift_instances add column if not exists note text;

commit;
