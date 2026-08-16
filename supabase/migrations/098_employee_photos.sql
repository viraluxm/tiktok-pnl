-- 098_employee_photos.sql
-- ⚠️ DESIGN DRAFT until applied. Employee photos for the record + printed badges (kiosk photo-on-scan
-- is an OPTIONAL future consumer, NOT built). Additive: a nullable column + a PRIVATE Storage bucket +
-- owner-folder RLS. Touches only employees + storage — no capture/order-sync tables (not gated).
--
-- PRIVATE bucket (unlike 024's public inventory-thumbnails) because headshots are PII: the app serves
-- them server-side as data-URIs via the service-role print-sheet route, never a public CDN URL. The
-- owner-folder policies below are defense-in-depth for any direct authenticated access; service-role
-- (the upload/print routes) bypasses RLS.

insert into storage.buckets (id, name, public)
values ('employee-photos', 'employee-photos', false)
on conflict (id) do nothing;

alter table public.employees
  add column if not exists photo_path text;   -- object path "{owner_user_id}/{employee_id}.<ext>", NOT a URL

-- Storage policies — objects live under "{owner_user_id}/...". No public read (private bucket).
-- Drop-then-create keeps this safe to re-run.
drop policy if exists "employee-photos owner read" on storage.objects;
create policy "employee-photos owner read"
  on storage.objects for select to authenticated
  using (bucket_id = 'employee-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "employee-photos owner insert" on storage.objects;
create policy "employee-photos owner insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "employee-photos owner update" on storage.objects;
create policy "employee-photos owner update"
  on storage.objects for update to authenticated
  using (bucket_id = 'employee-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "employee-photos owner delete" on storage.objects;
create policy "employee-photos owner delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'employee-photos' and (storage.foldername(name))[1] = auth.uid()::text);
