-- 043_fulfillment_devices.sql — Identity/Auth phase, CHUNK 6: provisioned warehouse devices.
-- Creates fulfillment_devices, then adds the deferred fulfillment_shifts.device_id FK (chunk 4).
-- Order matters: the table is created BEFORE the ALTER, so the FK target exists in-txn.
-- Additive, transaction-wrapped, idempotent. Same style as 039–042.
--
-- Reverse:
--   alter table public.fulfillment_shifts drop column if exists device_id;
--   drop table if exists public.fulfillment_devices;

begin;

-- Provisioned devices. A device runs under the shared org "fulfillment" auth account; this
-- row + a per-device token identify WHICH physical device it is (and its fixed kind).
create table if not exists public.fulfillment_devices (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  kind              text not null check (kind in ('picker','packer')),   -- fixed by hardware
  label             text,                                                 -- "Pack station 1", "PDA #2"
  device_token_hash text not null,                                        -- sha256(token) hex; plaintext token lives only on the device
  is_active         boolean not null default true,                        -- revoke a single device by flipping this
  provisioned_by    uuid references auth.users(id) on delete set null,    -- which owner provisioned it
  last_seen_at      timestamptz null,                                     -- device check-in telemetry (see touch note in plan)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_fd_org on public.fulfillment_devices(org_id);
-- token hashes are unique → fast, unambiguous validation lookup + collision guard
create unique index if not exists uniq_fd_token_hash on public.fulfillment_devices(device_token_hash);

drop trigger if exists fulfillment_devices_set_updated_at on public.fulfillment_devices;
create trigger fulfillment_devices_set_updated_at before update on public.fulfillment_devices
  for each row execute function public.set_updated_at();

alter table public.fulfillment_devices enable row level security;
drop policy if exists "fd org read"     on public.fulfillment_devices;
drop policy if exists "fd owner insert" on public.fulfillment_devices;
drop policy if exists "fd owner update" on public.fulfillment_devices;
drop policy if exists "fd owner delete" on public.fulfillment_devices;
-- READ: any org member (the device account reads its own row to validate; owners list devices).
create policy "fd org read"     on public.fulfillment_devices for select using (public.is_org_member(org_id));
-- WRITE (provision / revoke / edit): store-owners only — provisioning is an owner action.
create policy "fd owner insert" on public.fulfillment_devices for insert with check (public.is_store_owner_in_org(org_id));
create policy "fd owner update" on public.fulfillment_devices for update using (public.is_store_owner_in_org(org_id)) with check (public.is_store_owner_in_org(org_id));
create policy "fd owner delete" on public.fulfillment_devices for delete using (public.is_store_owner_in_org(org_id));

-- Deferred from chunk 4: which device a shift ran on. Nullable, on delete set null.
alter table public.fulfillment_shifts
  add column if not exists device_id uuid references public.fulfillment_devices(id) on delete set null;
create index if not exists idx_fs_device on public.fulfillment_shifts(device_id) where device_id is not null;

commit;
