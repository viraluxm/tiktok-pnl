-- 066_shipment_verification_picker.sql
-- Phase 1 of Fulfillment Picker Performance.
--
-- Adds picker attribution to the EXISTING pick-completion event (shipment_verifications,
-- migration 029) — the single, idempotent (user_id, group_key) upsert the packing-station
-- flow already makes on "Finish box". This is the safest model: purely additive, no new
-- table, no second write, no RLS change. One raw completed-box event per verification is
-- preserved; NO daily averages / KPI totals are stored (all KPIs are computed at read time).
--
--   picker_employee_id   → employees(id), ON DELETE SET NULL so deleting an employee never
--                          destroys the completion event; the human-readable attribution
--                          survives via picker_name_snapshot.
--   picker_name_snapshot → the picker's name AT PICK TIME, so historical reports survive an
--                          employee rename or deletion.
--
-- Existing historical rows keep NULL for both columns and render as "Unassigned".
--
-- RLS is deliberately UNCHANGED: the existing per-user policies (auth.uid() = user_id) on
-- shipment_verifications already cover these new columns (single-account model — every
-- picker's events share the managing account's user_id, so the account owner already reads
-- them all). Cross-account leaderboards are out of Phase 1 scope.

alter table public.shipment_verifications
  add column if not exists picker_employee_id uuid,
  add column if not exists picker_name_snapshot text;

-- FK guarded for idempotency (a re-run must not error). ON DELETE SET NULL — see header.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'shipment_verifications_picker_employee_id_fkey'
  ) then
    alter table public.shipment_verifications
      add constraint shipment_verifications_picker_employee_id_fkey
      foreign key (picker_employee_id) references public.employees(id) on delete set null;
  end if;
end $$;

-- Indexes for the two Phase-1 read patterns:
--   • daily performance for ALL pickers:        (user_id, verified_at)
--   • date-range performance for ONE picker:    (user_id, picker_employee_id, verified_at)
create index if not exists idx_sv_user_verified
  on public.shipment_verifications (user_id, verified_at);
create index if not exists idx_sv_user_picker_verified
  on public.shipment_verifications (user_id, picker_employee_id, verified_at);
