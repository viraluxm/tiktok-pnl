-- 059_channel_store_map.sql
--
-- Software-owned CHANNEL → STORE mapping. Replaces the LIMIT-1 store guess: a live's
-- store is derived from its captured streaming-channel name (live_sessions.channel_handle)
-- via this table. Many channels can map to one shop; a channel with NO row here is left
-- unmapped (store_id NULL) and flagged for an admin to map (Part D) — never guessed.
--
-- New empty table (then one confirmed seed row). Independent of live_sessions — no lock
-- on the live path, safe to create anytime.

begin;

create table if not exists public.channel_store_map (
  id           uuid primary key default gen_random_uuid(),
  channel_name text not null unique,
  store_id     uuid not null references public.stores(id),
  created_at   timestamptz not null default now()
);

-- RLS: admin-only read/write from the app. The store-derivation trigger reads this table
-- via SECURITY DEFINER, so it bypasses RLS and does NOT need a policy for the trigger.
alter table public.channel_store_map enable row level security;

drop policy if exists channel_store_map_admin_all on public.channel_store_map;
create policy channel_store_map_admin_all on public.channel_store_map
  for all
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Seed: the ONE confirmed channel. Others are intentionally left unmapped (flag via Part D).
insert into public.channel_store_map (channel_name, store_id)
values ('onlybidss', '1d71a4c9-16b1-45f2-858e-64b41c548e9e')  -- Snore
on conflict (channel_name) do nothing;

commit;
