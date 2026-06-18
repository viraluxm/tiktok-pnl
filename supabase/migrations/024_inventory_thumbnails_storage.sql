-- Inventory SKU thumbnails via image upload (no pasted URL).
-- PUBLIC bucket so thumbnails serve straight from Supabase's CDN with stable,
-- browser-cacheable URLs and no per-request signing (fastest display).
-- Writes are restricted to each user's own top-level folder via storage RLS.

-- 1) Bucket (public).
insert into storage.buckets (id, name, public)
values ('inventory-thumbnails', 'inventory-thumbnails', true)
on conflict (id) do nothing;

-- 2) Store the object PATH (not a URL); the API derives the public URL for display.
alter table public.inventory_skus
  add column if not exists thumbnail_path text;

-- 3) Storage policies. Objects live under "{user_id}/skus/...".
--    Drop-then-create keeps this migration safe to re-run.
drop policy if exists "inventory-thumbnails public read" on storage.objects;
create policy "inventory-thumbnails public read"
  on storage.objects for select
  using (bucket_id = 'inventory-thumbnails');

drop policy if exists "inventory-thumbnails owner insert" on storage.objects;
create policy "inventory-thumbnails owner insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'inventory-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "inventory-thumbnails owner update" on storage.objects;
create policy "inventory-thumbnails owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'inventory-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "inventory-thumbnails owner delete" on storage.objects;
create policy "inventory-thumbnails owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'inventory-thumbnails'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
