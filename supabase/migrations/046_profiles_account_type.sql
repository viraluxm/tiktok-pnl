-- 046_profiles_account_type.sql — Identity/Auth phase, CHUNK 10: account-type route confinement.
-- Adds profiles.account_type to branch the route guard. FAIL-SAFE by design:
--   * DEFAULT 'store' → every existing profile (owners: Alvaro, Abe) becomes 'store' → FULL access.
--   * Only the shared fulfillment account(s) get 'fulfillment' (confined to device routes).
--   * The guard confines ONLY on account_type = 'fulfillment'; null/store/error → full access.
-- So this migration cannot lock an owner out. Additive, transaction-wrapped, idempotent.
-- Reverse: alter table public.profiles drop column if exists account_type;

begin;

alter table public.profiles
  add column if not exists account_type text not null default 'store'
  check (account_type in ('store', 'fulfillment'));

-- Tag ONLY the shared fulfillment account(s) (org members with role 'fulfillment'), creating
-- the profile row if somehow missing. Everyone else stays 'store' (the column default).
insert into public.profiles (id, account_type)
  select user_id, 'fulfillment' from public.organization_members where role = 'fulfillment'
  on conflict (id) do update set account_type = 'fulfillment';

commit;
