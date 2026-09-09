-- 132_tracking_history_trigger.sql
--
-- Make tracking history COMPLETE, and make it READABLE.
--
-- 066 created tracking_correction_log and two routes write to it (/api/shipping/sync-tracking
-- and /api/cron/sync-orders). Three other paths overwrite synced_order_ids.tracking_number and
-- log NOTHING:
--
--   • src/lib/tiktok/syncCore.ts:185,321 — the bulk upsert that runs on EVERY sync. Rows whose
--     tracking is non-null are upserted with tracking_number included, so a superseded tracking
--     is replaced silently. This is the largest hole by far.
--   • src/app/api/shipping/labels/pdf/route.ts:280 — the print-time writeback.
--   • src/app/api/admin/orders/backfill-tracking/route.ts:158 — the admin backfill.
--
-- Patching five call sites leaves the sixth to whoever writes it next, so the guarantee is moved
-- into the DATABASE: any statement that changes a non-null tracking_number to a different
-- non-null value records the old one. A code path cannot opt out, and none needs to know.
--
-- WHY THIS MATTERS AT THE PACK STATION: TikTok re-labels combine shipments (one consolidated
-- label -> N per-package labels). A label already printed and stuck to a parcel then carries a
-- tracking the order no longer stores, and the picker is told "No matching order" for a box that
-- is sitting right there. This table is what lets the scanner recognise a superseded label.
--
-- MEASURED BEFORE WRITING (2026-09-07): impact today is zero — all 196 existing log rows are for
-- orders long past packing, and every one of their old trackings still resolves to some order.
-- This is preventive. It is cheap and it cannot be added retroactively: history not captured at
-- the moment of the overwrite is gone for good.
--
-- Deploy notes:
--   • Class A. `create trigger` takes a brief ACCESS EXCLUSIVE lock on synced_order_ids, which is
--     hot, so lock_timeout is set: it either takes the lock in 3s or fails harmlessly, and can be
--     retried. It does NOT rewrite the table.
--   • Safe mid-show. Nothing reads this table during capture, and the trigger only adds an insert
--     on the rare rows where a tracking actually changed.

set lock_timeout = '3s';

-- The scanner looks a superseded label up BY its old tracking. 066 indexed order_id and
-- store_id but not old_tracking, so that lookup would have been a full scan.
create index if not exists idx_tracking_correction_log_old_tracking
  on public.tracking_correction_log (old_tracking)
  where old_tracking is not null;

create or replace function public.log_tracking_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a genuine SUPERSEDE is history worth keeping:
  --   • old null  -> a fill, nothing is lost (this is the COALESCE-safe path, by far the common
  --                  case, and logging it would bury real corrections in noise);
  --   • new null  -> cannot be recorded, new_tracking is NOT NULL in 066. The writers are all
  --                  COALESCE-safe so this does not occur; if it ever does, the old value is lost
  --                  and that is worth knowing, so it is asserted rather than silently skipped.
  --   • unchanged -> the bulk upsert re-writes the same value on most rows; `is distinct from`
  --                  keeps that free.
  if old.tracking_number is null then return new; end if;
  if new.tracking_number is not distinct from old.tracking_number then return new; end if;

  if new.tracking_number is null then
    raise warning 'tracking_number nulled for order % (was %) — history not recorded, new_tracking is NOT NULL',
      new.order_id, old.tracking_number;
    return new;
  end if;

  insert into public.tracking_correction_log
    (user_id, store_id, order_id, old_tracking, new_tracking, combine_group_id, source)
  values
    (new.user_id, new.store_id, new.order_id, old.tracking_number, new.tracking_number,
     new.auto_combine_group_id, 'trigger');

  return new;
end
$$;

-- `of tracking_number` so the trigger is not even considered for the many updates that do not
-- touch it (status refreshes, doc writebacks).
drop trigger if exists synced_order_ids_log_tracking_change on public.synced_order_ids;
create trigger synced_order_ids_log_tracking_change
  after update of tracking_number on public.synced_order_ids
  for each row
  execute function public.log_tracking_change();

reset lock_timeout;
