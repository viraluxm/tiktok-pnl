-- 065_onboarding_rls.sql
--
-- ⚠️ STAGED — NOT YET APPLIED. SECURITY-CRITICAL. Apply ONLY after explicit
-- line-by-line approval, on a quiet window, then read back (see the apply/verify
-- checklist at the bottom).
--
-- Three tables currently have RLS DISABLED in prod (confirmed live 2026-07-24):
--   stores, store_members  — out-of-band tables, never had RLS.
--   synced_order_ids       — CRITICAL: anon + authenticated hold full grants,
--                            so the PUBLIC anon key reads ALL ~45k order rows
--                            (proven: /rest/v1/synced_order_ids → 0-0/45482).
--
-- Every policy below is SELECT-only with a narrowing USING clause — it can only
-- REDUCE visibility, never widen it. NO write policies are added: all writes go
-- through the service-role admin client (verified — store/membership writes in
-- the OAuth callback, order writes in tiktok/sync), which bypasses RLS.
--
-- Helper fns used (all exist, all SECURITY DEFINER): is_org_member(p_org uuid).

begin;

-- ── Part 1 — stores: a user sees stores ONLY in orgs they belong to ──────────
alter table public.stores enable row level security;

drop policy if exists stores_org_member_sel on public.stores;
create policy stores_org_member_sel on public.stores
  for select
  using (public.is_org_member(org_id));
-- No INSERT/UPDATE/DELETE policy → service-role only (OAuth callback creates stores).

-- ── Part 2 — store_members: a user sees ONLY their own membership rows ───────
alter table public.store_members enable row level security;

drop policy if exists store_members_self_sel on public.store_members;
create policy store_members_self_sel on public.store_members
  for select
  using (user_id = auth.uid());
-- Deliberately NOT "see co-members in my store" — that would widen access beyond
-- onboarding. Writes: service-role only.

-- ── Part 3 — synced_order_ids: CRITICAL. Scope reads to the owning user ──────
-- Closes the live world-readable exposure. Sync writes via service-role (admin
-- client, onConflict user_id,order_id) so they are unaffected by RLS.
alter table public.synced_order_ids enable row level security;

drop policy if exists synced_order_ids_self_sel on public.synced_order_ids;
create policy synced_order_ids_self_sel on public.synced_order_ids
  for select
  using (user_id = auth.uid());
-- No user write policy → service-role only.

commit;

-- ── APPLY / VERIFY CHECKLIST (run manually, gated) ───────────────────────────
-- 1. Pre-check (live, drift): confirm RLS is still OFF on all three and that
--    tiktok/sync + the callback still use the admin client for writes.
-- 2. Apply in the quiet window (no active live: no auction close / heartbeat ~15m).
-- 3. Read back:
--      select relname, relrowsecurity from pg_class
--        where relname in ('stores','store_members','synced_order_ids');   -- all t
--      select tablename, policyname, cmd, qual from pg_policies
--        where tablename in ('stores','store_members','synced_order_ids');
-- 4. Anon-key re-probe of synced_order_ids → expect 0 rows / 401 (was 0-0/45482).
-- 5. Owner regression: existing owner still sees Snore + lots of steals + orders.
-- 6. Sync smoke test: run a sync, confirm rows still upsert (admin client).
--
-- NOTE: Part 3 (synced_order_ids) is independently applicable and can be
-- cherry-applied FIRST as an emergency patch ahead of the onboarding work.
