-- 065_scan_log.sql
-- Append-only log of EVERY packing-station scan (resolved or not), so failed/mis-formatted scans
-- become diagnosable. Today's first real run had failures visible nowhere — a packer reported a
-- scanner emitting extra characters (possibly GS1-128 AI prefixes) and we had no raw value to see.
-- The RAW scanned string is the point. `set_aside` records boxes the resolver flags for set-aside
-- (contains an unbound-auction order) so "did a catalog box get set aside" is answerable.
--
-- Written fire-and-forget by /api/shipping/pick-list via the service role; a logging failure must
-- NEVER block a scan. (065: 064 is taken by lensed_unbind on a parallel branch — renumber at merge
-- if needed.)

create table if not exists public.scan_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  store_id   uuid,
  raw_scan   text not null,                 -- the exact string the scanner emitted (verbatim)
  resolved   boolean not null,              -- did it resolve to a box?
  group_key  text,                          -- resolved box key (null when unresolved)
  set_aside  boolean not null default false,-- resolved box requires set-aside (has unbound-auction)
  error      text,                          -- failure reason when unresolved
  scanned_at timestamptz not null default now()
);

create index if not exists idx_scan_log_user_time on public.scan_log (user_id, scanned_at desc);

-- Service-role writes only (pick-list uses the admin client); no public policies.
alter table public.scan_log enable row level security;
