-- 047_store_id_triggers.sql — Identity/Auth phase, CHUNK 11: store-aware writes.
-- Legacy write paths (tiktok sync, live, capture, rebuild_entries, ad_spend) don't set store_id,
-- so new rows accrue NULL (and rebuild_entries wipes it on entries). Fix at the DB level with
-- triggers (mirrors 035b's set_org_id_on_insert) + a one-time backfill. Covers service-role
-- writers and rebuild_entries. Additive, transaction-wrapped, idempotent.
-- Reverse: drop the set_store_id triggers on the 10 tables; drop the two functions.

begin;

-- user-owned tables: store_id = the owning login's store (user_id → store_members, 1:1).
create or replace function public.set_store_id_from_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.store_id is null then
    NEW.store_id := (select sm.store_id from public.store_members sm where sm.user_id = NEW.user_id limit 1);
  end if;
  return NEW;
end $$;

-- ad_spend exception: store = the business connection's store (the ad account's store), NOT
-- the login's store (F5 attributed ad_spend to Snore via the business connection).
create or replace function public.set_store_id_from_bizconn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.store_id is null then
    NEW.store_id := (select bc.store_id from public.tiktok_business_connections bc where bc.user_id = NEW.user_id limit 1);
  end if;
  return NEW;
end $$;

-- attach before-insert-or-update triggers (coalesce → never clobbers an already-set store_id)
do $$ declare t text; begin
  foreach t in array array['synced_order_ids','entries','live_sessions','live_auction_items',
      'live_auction_item_skus','capture_events','order_payouts','shop_videos','shipment_verifications'] loop
    execute format('drop trigger if exists set_store_id on public.%I', t);
    execute format('create trigger set_store_id before insert or update on public.%I for each row execute function public.set_store_id_from_user()', t);
  end loop;
end $$;
drop trigger if exists set_store_id on public.ad_spend;
create trigger set_store_id before insert or update on public.ad_spend for each row execute function public.set_store_id_from_bizconn();

-- one-time backfill of existing NULLs
update public.synced_order_ids      s set store_id=(select store_id from public.store_members where user_id=s.user_id limit 1) where s.store_id is null;
update public.entries               e set store_id=(select store_id from public.store_members where user_id=e.user_id limit 1) where e.store_id is null;
update public.live_sessions         x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.live_auction_items    x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.live_auction_item_skus x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.capture_events        x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.order_payouts         x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.shop_videos           x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.shipment_verifications x set store_id=(select store_id from public.store_members where user_id=x.user_id limit 1) where x.store_id is null;
update public.ad_spend              a set store_id=(select store_id from public.tiktok_business_connections where user_id=a.user_id limit 1) where a.store_id is null;

commit;
