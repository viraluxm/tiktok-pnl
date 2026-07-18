-- 060_store_id_from_channel_map.sql
--
-- ⚠️ STAGED — NOT YET APPLIED. Swaps store derivation on the SESSION-CREATION PATH, so
-- it is GATED: apply only when no live is active (no auction close / no heartbeat in
-- ~15 min), dry-run first.
--
-- Replaces the old set_store_id_from_user() which guessed store via
--   (select store_id from store_members where user_id = NEW.user_id LIMIT 1)
-- — wrong for any multi-store user (collapsed every channel onto one store).
--
-- New behavior: derive store from the captured streaming-channel name via
-- channel_store_map. Match → set store_id. NO match → leave store_id NULL (the
-- "needs mapping" signal that Part D flags). NEVER fall back to the LIMIT-1 guess.
--
-- Runs on INSERT OR UPDATE (trigger `set_store_id`, unchanged): at INSERT channel_handle
-- is not set yet → store_id NULL; on the later UPDATE where the extension stamps
-- channel_handle → store_id derives. Only fills when store_id IS NULL, so it never
-- overwrites a store already set (manual fix / prior backfill).

create or replace function public.set_store_id_from_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.store_id is null and NEW.channel_handle is not null then
    NEW.store_id := (
      select m.store_id
      from public.channel_store_map m
      where m.channel_name = NEW.channel_handle
      limit 1
    );
  end if;
  -- No LIMIT-1 store_members fallback: unmapped channel ⇒ store_id stays NULL ⇒ flagged.
  return NEW;
end $$;
