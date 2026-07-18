-- 061_guard_set_store_id_from_user.sql
--
-- Reconciliation of the store-derivation trigger function after the 060 breakage.
--
-- BACKGROUND
--   Migration 060 rewrote the SHARED function set_store_id_from_user() to derive
--   store_id from channel_store_map via NEW.channel_handle -- but UNGUARDED. That
--   function backs the `set_store_id` trigger, whose documented backstop set
--   (migration 041) includes tables that have NO channel_handle column:
--   live_auction_items, live_auction_item_skus, entries. On any of those the
--   function raises 42703 (undefined_column) on every insert/update.
--
--   To stop the live breakage the `set_store_id` trigger was manually DROPPED
--   from the child tables; as of this migration it survives only on live_sessions
--   (the one table that actually has channel_handle), so the unguarded function
--   happens to work there. That manual fix is NOT recorded in any migration.
--
-- WHAT THIS DOES
--   Makes the FUNCTION itself safe on EVERY table by gating the channel->store
--   logic behind TG_TABLE_NAME. The trigger topology can then be whatever we
--   choose -- recreated on the child tables OR left dropped -- with no 42703
--   either way.
--
-- BEHAVIOR
--   * live_sessions: IDENTICAL to 060 (derive store_id from channel_store_map
--     when store_id is null and channel_handle is set). No functional change.
--   * every other table: safe no-op -- returns NEW untouched. store_id stays as
--     supplied (NULL if not provided). All five backstop tables are nullable with
--     no default, so a null store_id never fails the insert.
--
-- SAFETY
--   Single CREATE OR REPLACE in one transaction. On live it is effectively a
--   no-op change for live_sessions and harmless everywhere else, so it is safe to
--   apply even with a live in progress.

begin;

create or replace function public.set_store_id_from_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Channel->store derivation applies ONLY to live_sessions, the sole table that
  -- carries channel_handle. Elsewhere this function is a safe no-op, so the shared
  -- `set_store_id` trigger can exist on any table without raising 42703.
  if TG_TABLE_NAME = 'live_sessions' then
    if NEW.store_id is null and NEW.channel_handle is not null then
      NEW.store_id := (
        select m.store_id
        from public.channel_store_map m
        where m.channel_name = NEW.channel_handle
        limit 1
      );
    end if;
  end if;
  return NEW;
end $$;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL (not enabled): pin the trigger topology in migration history so a
-- fresh replay reproduces tonight's manually-fixed live state instead of leaving
-- the `set_store_id` trigger layout defined out-of-band. Uncomment ONLY if you
-- want the repo to own the topology. With 061's guard in place, recreating the
-- trigger on the child tables is now harmless, so either choice is safe.
--
-- begin;
--   -- Keep it OFF the tables where it was manually dropped tonight:
--   drop trigger if exists set_store_id on public.live_auction_items;
--   drop trigger if exists set_store_id on public.live_auction_item_skus;
--   drop trigger if exists set_store_id on public.entries;
--   drop trigger if exists set_store_id on public.ad_spend;
--
--   -- Keep it ON live_sessions (load-bearing for channel->store derivation):
--   drop trigger if exists set_store_id on public.live_sessions;
--   create trigger set_store_id
--     before insert or update on public.live_sessions
--     for each row execute function public.set_store_id_from_user();
-- commit;
