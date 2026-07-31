-- 074_tiktok_connections_shop_id.sql
--
-- Persist TikTok's numeric shop id on tiktok_connections. Until now only shop_cipher /
-- shop_name / shop_logo were stored; the numeric shop_id (returned by getAuthorizedShops)
-- was discarded (docs/returns/returns-refunds-audit.md:82). shop_cipher has no unique
-- constraint and its stability across re-authorization is unverified, so it cannot be
-- trusted as a per-shop identity key. shop_id gives us a stable one to key future
-- idempotency / dedupe logic on.
--
-- Stored as TEXT: TikTok ids can exceed JS safe-integer range and must never be parsed as a
-- number anywhere (matching ShopInfo.shop_id in src/lib/tiktok/client.ts).
--
-- NUMBERING: 074. 072 is an uncommitted concurrent-session migration
-- (072_channel_resolve_conflict_log.sql) and 073 is taken by the stores DDL capture on
-- feat/add-store-creation, so 074 is the next free prefix above both. ⚠️ The live DB has NO
-- migration ledger — migrations are applied BY HAND — so verify the current live schema
-- before hand-applying this (a duplicated prefix would be a skip / double-apply hazard).
--
-- Safe to apply anytime: additive nullable column + a plain index, no rewrite, no lock of
-- consequence.

begin;

alter table public.tiktok_connections
  add column if not exists shop_id text;

-- Non-unique index: shop_id is the natural lookup/dedupe key for a shop.
create index if not exists idx_tiktok_connections_shop_id
  on public.tiktok_connections (shop_id);

-- NO unique constraint on shop_id (deliberate). Existing rows are all NULL until backfilled,
-- and a unique index would (a) require a backfill first and (b) risk breaking re-auth if the
-- same shop legitimately maps to more than one row during a transition. Add uniqueness later,
-- only after shop_id is fully backfilled and the desired cardinality is confirmed.

commit;
