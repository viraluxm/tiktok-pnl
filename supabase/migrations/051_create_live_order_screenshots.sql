-- 051_create_live_order_screenshots.sql
-- (Renumbered from a stale 038 that collided with 038_add_reorder_planning on main.)
-- Screenshot proof/recovery for TikTok LIVE auctions (extension canvas capture,
-- upload-first). User-owned to match live_sessions / capture_events / order_payouts
-- (035b left the live-selling tables user_id-scoped; only shared inventory got org_id).
--
-- NOTE: prod ALREADY has this table + the live-screenshots bucket from an out-of-band
-- apply. This migration reconciles the repo to that state; it is fully idempotent /
-- no-op-safe (create-if-not-exists, guarded policies/trigger, on-conflict bucket
-- insert), so re-applying it changes nothing. Do NOT apply during an active live.
--
-- Storage: PRIVATE bucket `live-screenshots` (captures can contain buyer PII / the
-- host camera — never public). Display is via server-generated signed URLs only.
-- Idempotency: unique (user_id, image_id) so the extension's merge-duplicates upsert
-- and any retry replay without creating duplicate rows; object keys are deterministic
-- ({user_id}/{session_id}/{image_id}.jpg) so a re-upload overwrites in place.
--
-- Idempotent: safe to re-run.

create extension if not exists "uuid-ossp";

-- ── 1. Table ─────────────────────────────────────────────────────────────────
create table if not exists public.live_order_screenshots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_id text not null,                       -- client-minted uuid; idempotency key
  session_id uuid,                              -- FK added below (guarded)
  room_id text,
  order_id text,                                -- null for start/manual; joins capture_events.order_id
  auction_attempt_id text,                      -- null now; future auction_start pairing
  screenshot_type text not null
    check (screenshot_type in ('auction_start', 'auction_end', 'manual_test')),
  start_trigger text,                           -- null now; future ('tiktok_auction_start' | 'dom' | ...)
  tiktok_auction_id text,                       -- null now; future correlation
  tiktok_round_id text,                         -- null now; future correlation
  object_key text not null,                     -- storage path within the bucket
  storage_provider text not null default 'supabase',
  width integer,
  height integer,
  bytes integer,
  staged_skus_snapshot jsonb,                   -- metadata only (SKUs never trigger capture)
  buyer_username text,
  price_cents integer,
  captured_at timestamptz,
  upload_status text not null default 'uploaded'
    check (upload_status in ('uploaded', 'pending', 'failed')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reconcile columns if a table predates any of them (no-op when present).
alter table public.live_order_screenshots add column if not exists auction_attempt_id text;
alter table public.live_order_screenshots add column if not exists tiktok_auction_id text;
alter table public.live_order_screenshots add column if not exists tiktok_round_id text;
alter table public.live_order_screenshots add column if not exists staged_skus_snapshot jsonb;
alter table public.live_order_screenshots add column if not exists metadata jsonb;

-- ── 2. Indexes ───────────────────────────────────────────────────────────────
-- Unique (user_id, image_id): the extension's merge-duplicates upsert + retry key.
create unique index if not exists idx_live_order_screenshots_user_image
  on public.live_order_screenshots (user_id, image_id);
create index if not exists idx_live_order_screenshots_user_id  on public.live_order_screenshots (user_id);
create index if not exists idx_live_order_screenshots_order_id on public.live_order_screenshots (order_id);
create index if not exists idx_live_order_screenshots_session  on public.live_order_screenshots (session_id);
-- NOTE: the partial UNIQUE index on (user_id, order_id) for auction_end is created in
-- section 8 — AFTER the one-time duplicate cleanup, so pre-fix random-id duplicates
-- can't make the CREATE UNIQUE INDEX fail.

-- ── 3. session_id FK (guarded; live_sessions is user-owned) ───────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'live_order_screenshots_session_id_fkey') then
    alter table public.live_order_screenshots
      add constraint live_order_screenshots_session_id_fkey
      foreign key (session_id) references public.live_sessions(id) on delete set null;
  end if;
end $$;

-- ── 4. updated_at trigger (public.set_updated_at defined in 021) ──────────────
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.live_order_screenshots'::regclass
      and tgname  = 'set_live_order_screenshots_updated_at'
      and not tgisinternal
  ) then
    create trigger set_live_order_screenshots_updated_at
      before update on public.live_order_screenshots
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ── 5. Session-ownership guard ───────────────────────────────────────────────
-- The FK guarantees session_id is a REAL live_sessions row, but not that it is the
-- CALLER'S. Since live_sessions is user-owned, block a row from referencing another
-- user's session: session_id must be NULL or point at the caller's own session.
-- security definer + fixed search_path mirrors is_org_member (035b) so the check is
-- reliable regardless of the caller's RLS view of live_sessions.
create or replace function public.owns_live_session_or_null(p_session uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_session is null
      or exists (select 1 from public.live_sessions s
                 where s.id = p_session and s.user_id = auth.uid());
$$;
grant execute on function public.owns_live_session_or_null(uuid) to authenticated;

-- ── 6. RLS: own-row only (auth.uid() = user_id) + session-ownership on writes ──
alter table public.live_order_screenshots enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='live_order_screenshots'
                 and policyname='Users can view own live_order_screenshots') then
    create policy "Users can view own live_order_screenshots"
      on public.live_order_screenshots for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='live_order_screenshots'
                 and policyname='Users can insert own live_order_screenshots') then
    create policy "Users can insert own live_order_screenshots"
      on public.live_order_screenshots for insert
      with check (auth.uid() = user_id and public.owns_live_session_or_null(session_id));
  end if;
  if not exists (select 1 from pg_policies where tablename='live_order_screenshots'
                 and policyname='Users can update own live_order_screenshots') then
    create policy "Users can update own live_order_screenshots"
      on public.live_order_screenshots for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id and public.owns_live_session_or_null(session_id));
  end if;
  if not exists (select 1 from pg_policies where tablename='live_order_screenshots'
                 and policyname='Users can delete own live_order_screenshots') then
    create policy "Users can delete own live_order_screenshots"
      on public.live_order_screenshots for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ── 7. Private storage bucket `live-screenshots` ─────────────────────────────
-- PRIVATE (public=false): objects are fetched only via signed URLs the app mints.
insert into storage.buckets (id, name, public)
values ('live-screenshots', 'live-screenshots', false)
on conflict (id) do nothing;

-- Storage RLS — objects live under "{user_id}/...". Owner-only for ALL ops
-- (including select — no public read). Drop-then-create keeps this re-runnable.
drop policy if exists "live-screenshots owner select" on storage.objects;
create policy "live-screenshots owner select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'live-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "live-screenshots owner insert" on storage.objects;
create policy "live-screenshots owner insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'live-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "live-screenshots owner update" on storage.objects;
create policy "live-screenshots owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'live-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "live-screenshots owner delete" on storage.objects;
create policy "live-screenshots owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'live-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 8. One-time cleanup of duplicate auction_end rows + backstop unique index ──
-- Pre-fix builds minted a RANDOM image_id per capture, so a reload/catch-up within
-- the freshness window produced multiple auction_end rows for the same (user_id,
-- order_id). Those must be collapsed to ONE before the partial unique index can be
-- created. The extension now writes a deterministic image_id ('end-<order_id>'), so
-- this repair is one-time; it is idempotent (a clean table is a no-op).

-- Durable audit of every removed row (incl. its object_key → orphan Storage GC later).
create table if not exists public.live_order_screenshot_dedup (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  order_id text not null,
  kept_id uuid not null,
  removed_id uuid not null,
  removed_image_id text,
  removed_object_key text,
  removed_upload_status text,
  repaired_at timestamptz not null default now()
);

do $$
declare g record; v_keep uuid; v_groups int := 0; v_removed int := 0; v_rc int;
begin
  for g in
    select user_id, order_id
    from public.live_order_screenshots
    where screenshot_type = 'auction_end' and order_id is not null
    group by user_id, order_id
    having count(*) > 1
  loop
    v_groups := v_groups + 1;
    -- Canonical preference: the deterministic 'end-<order_id>' row → then an uploaded
    -- row → then the newest. Deterministic, so re-runs pick the same survivor.
    select id into v_keep
      from public.live_order_screenshots
      where user_id = g.user_id and order_id = g.order_id and screenshot_type = 'auction_end'
      order by (image_id = 'end-' || order_id) desc,
               (upload_status = 'uploaded') desc,
               created_at desc, id desc
      limit 1;

    insert into public.live_order_screenshot_dedup
      (user_id, order_id, kept_id, removed_id, removed_image_id, removed_object_key, removed_upload_status)
    select g.user_id, g.order_id, v_keep, id, image_id, object_key, upload_status
      from public.live_order_screenshots
      where user_id = g.user_id and order_id = g.order_id and screenshot_type = 'auction_end'
        and id <> v_keep;

    -- NOTE: the now-orphaned Storage objects for removed rows are NOT deleted here —
    -- Supabase blocks direct DELETE on storage.objects (storage.protect_delete()). Their
    -- object_key is recorded in live_order_screenshot_dedup above; GC them out-of-band
    -- via the Storage API (storage.from('live-screenshots').remove([...])) when convenient.

    delete from public.live_order_screenshots
      where user_id = g.user_id and order_id = g.order_id and screenshot_type = 'auction_end'
        and id <> v_keep;
    get diagnostics v_rc = row_count;
    v_removed := v_removed + v_rc;
  end loop;
  raise notice 'live_order_screenshots dedup: % group(s), % duplicate row(s) removed', v_groups, v_removed;
end $$;

-- Backstop: at most ONE auction_end screenshot per (user_id, order_id). The extension
-- already guarantees this via the deterministic image_id + (user_id,image_id) upsert,
-- so this should never fire in practice. manual_test / auction_start are excluded, so
-- they stay unique-per-capture.
create unique index if not exists idx_live_order_screenshots_user_order_end
  on public.live_order_screenshots (user_id, order_id)
  where screenshot_type = 'auction_end' and order_id is not null;
