-- 044_fulfillment_touch_and_role.sql — Identity/Auth phase, CHUNK 6 (support):
--   (1) add 'fulfillment' to the org_role enum so the shared device account can be tagged.
--   (2) touch_device() SECURITY DEFINER RPC — lets the device account bump last_seen_at
--       (writes are owner-only via RLS, so telemetry needs a definer path).
--
-- NOTE: `ALTER TYPE ... ADD VALUE` is intentionally run OUTSIDE an explicit transaction (the
-- robust form; the new value can't be used in the same txn that adds it). The function is
-- create-or-replace (idempotent). Reverse: drop function touch_device(uuid); (enum values
-- can't be dropped — harmless to leave).

-- (1) org_role gains 'fulfillment' (idempotent; standalone, no txn wrapper)
alter type public.org_role add value if not exists 'fulfillment';

-- (2) touch_device — bump last_seen_at only, guarded to the caller's org
create or replace function public.touch_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.fulfillment_devices
     set last_seen_at = now()
   where id = p_device_id
     and public.is_org_member(org_id);   -- only an org member of the device's org may touch it
end;
$$;
grant execute on function public.touch_device(uuid) to authenticated;
