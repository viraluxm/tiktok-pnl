-- 149_close_public_pnl_exposure.sql
-- Close a LIVE data exposure: the business's daily and order-level P&L was readable with NO LOGIN.
--
-- Verified against production 2026-09-10 using the anon key that ships inside the browser bundle
-- (so it is public by construction — it is in every page's JS):
--
--   GET /rest/v1/pnl_daily_fact    -> HTTP 200, 112 rows
--   GET /rest/v1/pnl_order_grain   -> HTTP 200, order-level rows
--
-- pnl_daily_fact exposed, per day per store: revenue_cents, cogs_cents, gross_margin_cents,
-- ad_spend_cents, host_labor_cents, fulfillment_labor_cents, net_profit_cents, refund_cents.
-- pnl_order_grain exposed order_id, revenue_cents, cogs_cents, sku, host_employee_id, session_id.
--
-- Two independent causes, both fixed here:
--   1. TABLES with RLS never enabled AND select granted to anon / authenticated. With RLS off, a
--      grant is the whole story: any holder of the key reads every row.
--   2. pnl_order_grain is a VIEW with security_invoker = false, owned by postgres — it runs with
--      the OWNER's rights and so bypasses RLS on its underlying tables entirely. anon held FULL
--      privileges on it (select, insert, update, delete, truncate).
--
-- ⚠️ MIGRATION LEDGER: no ledger on this DB; migrations are applied BY HAND and this file is the
--    only record. Prefix 149 chosen after `git fetch --all` + a scan of every branch AND both
--    working trees (highest claimed: 148). Fetch before you scan — an earlier scan in this session
--    missed unfetched branches and caused a real 137 collision.
--
-- LOCK FOOTPRINT: REVOKE and ALTER TABLE ... ENABLE ROW LEVEL SECURITY are catalog-only. No table
--    rewrite, no row touched. Each takes a brief ACCESS EXCLUSIVE lock, so run the whole file with
--    `set lock_timeout = '3s'`: the risk is not duration, it is a lock request queueing ahead of
--    live traffic. On timeout nothing is changed and the file can simply be re-run.
--
-- APPLIED TO PRODUCTION 2026-09-10. Applied PER TABLE, not as one transaction: the first attempt
--    at the whole file hit the 3s lock_timeout on synced_order_ids (the order-sync cron writes it
--    constantly) and rolled back entirely — the safe failure, nothing changed. Splitting it let the
--    live no-login exposure close immediately on cold tables while the hot one was retried.
--
-- ⚠️ THE FIRST AUDIT HAD A BLIND SPOT. It scanned only tables carrying a user_id column, which
--    missed five more that were equally open: ac_box_snapshots, cron_sync_runs, feed_noise_snapshot,
--    pages and stores. feed_noise_snapshot was the worst of them — order_id, tracking_number, gmv
--    and units, readable with NO LOGIN. Section 4 closes those. When auditing exposure, enumerate
--    by GRANT + relrowsecurity, never by column shape.
--
-- SAFE TO APPLY: verified before writing that NOTHING reads these from a browser —
--    0 client-side read sites for synced_order_ids / hosts / store_members across
--    src/components, src/hooks and src/app (excluding API routes), and NO app code references
--    pnl_daily_fact, pnl_refund_events or pnl_order_grain at all. Every server path uses the
--    service-role client, which bypasses RLS by design and is unaffected by all of this.

-- ---------------------------------------------------------------------------
-- 1. The no-login exposure. Revoke first: it is the part that is live right now.
--
--    anon  = the public key in the browser bundle. It must never reach business data.
--    authenticated = ANY logged-in account, including one created seconds ago on the open signup
--    endpoint (/api/auth/signup has no invite and no allowlist), which gets role NULL.
-- ---------------------------------------------------------------------------
revoke all on public.pnl_daily_fact    from anon, authenticated;
revoke all on public.pnl_refund_events from anon, authenticated;
revoke all on public.pnl_order_grain   from anon, authenticated;

-- The view bypassed RLS because it runs as its owner. Make it run as the CALLER so that even if a
-- grant is ever restored by hand, the underlying tables' RLS still applies. Belt and braces: the
-- revoke above is the actual fix, this stops the next accidental grant from re-opening it.
alter view public.pnl_order_grain set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 2. Tables that never had RLS switched on.
--
--    RLS is the backstop that makes a stray future GRANT harmless. Enabling it with no policy
--    denies all non-service-role access, which is exactly right for tables nothing reads from a
--    browser. store_members is the one exception and is handled below.
-- ---------------------------------------------------------------------------
alter table public.synced_order_ids                  enable row level security;
alter table public.hosts                             enable row level security;
alter table public.pnl_daily_fact                    enable row level security;
alter table public.pnl_refund_events                 enable row level security;
alter table public.live_auction_dedup_repairs        enable row level security;
alter table public.live_order_screenshot_dedup       enable row level security;
alter table public.synced_order_ids_archive_f5885f7d enable row level security;
alter table public.entries_archive_f5885f7d          enable row level security;

-- Belt and braces on the order history itself: nothing in a browser reads it, so the grant is
-- dead weight and a second line of defence costs nothing.
revoke all on public.synced_order_ids from anon, authenticated;
revoke all on public.hosts            from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. store_members — RLS ON, but it MUST keep its own-row read.
--
--    The channel_store_map_member_read policy is:
--        store_id in (select sm.store_id from store_members sm where sm.user_id = auth.uid())
--    A policy's subquery IS subject to the subqueried table's RLS. Enabling RLS on store_members
--    without a policy would make that subquery return nothing and silently break channel reads
--    for every member. The own-row policy below keeps it working while still preventing one
--    member from enumerating anyone else's memberships.
-- ---------------------------------------------------------------------------
alter table public.store_members enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='store_members'
      and policyname='Users can view own store_members'
  ) then
    create policy "Users can view own store_members" on public.store_members
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Tables with no user_id column — missed by the first pass, equally exposed.
--
--    feed_noise_snapshot carried order_id, tracking_number, gmv and units and was readable with
--    no login at all. Zero client-side read sites for all five; `stores` is read 16 times but only
--    ever server-side through the service-role client, which RLS does not apply to.
-- ---------------------------------------------------------------------------
alter table public.ac_box_snapshots    enable row level security;
alter table public.cron_sync_runs      enable row level security;
alter table public.feed_noise_snapshot enable row level security;
alter table public.pages               enable row level security;
alter table public.stores              enable row level security;

revoke all on public.ac_box_snapshots    from anon, authenticated;
revoke all on public.cron_sync_runs      from anon, authenticated;
revoke all on public.feed_noise_snapshot from anon, authenticated;
revoke all on public.pages               from anon, authenticated;
revoke all on public.stores              from anon, authenticated;

-- VERIFIED AFTER APPLYING: every object above returns 401 to the public anon key; no public table
-- is left with RLS off and a grant; no view is anon-readable. Packing, the station routes and both
-- manager boards all still 200, and 36 pack confirms landed in the 30 minutes after.
