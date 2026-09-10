-- 147_singles_batches.sql
-- Credit the SINGLES PREP STATION. A singles run prints one header slip per SKU
-- ("#428 CRUNCHY SOAP BAR ORIGINAL / 135 LABELS") followed by that SKU's labels. The packer
-- works the pile mechanically and today NONE of it is credited to anyone: measured 2026-09-07..09,
-- runs carried 521 / 323 / 304 / 261 labels under banner_caption = 'SINGLES — PREP STATION' with
-- ZERO appearing in shipment_verifications. That is ~500 packages a shift missing from every
-- picker KPI and from the $/box and $/SKU cost math (which is why those unit costs read ~40% high).
--
-- ⚠️ MIGRATION LEDGER: no ledger on this DB; migrations are applied BY HAND and this file is the
--    only record. Prefix 147 chosen after a FULL scan (git ls-files + every branch after
--    `git fetch --all` + both working trees): highest claimed was 145. An earlier scan in this
--    same session missed unfetched branches and produced a real 137 collision — see the header of
--    146_crew_board_tokens.sql. Fetch before you scan.
--    ➜ BEFORE HAND-APPLYING: confirm public.singles_batches does not exist and that
--      shipment_verifications has no `source` column.
--
-- LOCK FOOTPRINT — read before running during a shift:
--   * CREATE TABLE singles_batches — new table, locks nothing already in use.
--   * ALTER TABLE shipment_verifications ADD COLUMN source text (NULLABLE, NO DEFAULT) — a
--     catalog-only change on PG11+: no table rewrite, no row touched, milliseconds. It still needs
--     a brief ACCESS EXCLUSIVE lock, and shipment_verifications takes a write on every pack
--     confirm. RUN IT WITH `set lock_timeout = '3s'`. The danger is NOT the ALTER's duration — it
--     is that a lock request waiting in the queue blocks every confirm that arrives behind it. The
--     timeout caps that worst case at three seconds; on timeout the statement aborts having
--     changed nothing and can simply be re-run.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. singles_batches — one row per printed singles header slip.
--
--    ⚠️ SUPERSEDED BY 148: this file keys a pile on (run_id, slip_caption). That is wrong for how
--    labels are printed here — bought per shop, printed COMBINED, so one pile spans a dozen runs.
--    148 replaces the key with the pile's actual member boxes (group_keys). Apply BOTH, in order.
--
--    `code` is what the slip's barcode encodes — opaque, unique, never reused.
--
--    Deliberately a NEW table rather than a column on shipping_label_purchases: that table has one
--    row per LABEL and this is one row per PILE. It also keeps the ALTER footprint on a hot,
--    money-carrying table at zero.
--
--    The pile's member labels are NOT duplicated here — they are
--    `shipping_label_purchases where run_id = ? and slip_caption = ?`. One source of truth.
-- ---------------------------------------------------------------------------
create table if not exists public.singles_batches (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid,                             -- guarded FK below (out-of-band `stores`, 070 idiom)
  run_id uuid not null,                      -- the label run this pile was printed in
  slip_caption text not null,                -- '#428 CRUNCHY SOAP BAR ORIGINAL'
  code text not null,                        -- what the barcode encodes; Code128-B safe charset
  label_count integer not null,              -- labels in the pile at print time ("135 LABELS")
  created_at timestamptz not null default now(),
  constraint singles_batches_code_key unique (code),
  -- One pile per (run, caption): a re-print must resolve to the same batch.
  constraint singles_batches_run_caption_key unique (run_id, slip_caption),
  constraint singles_batches_label_count_positive check (label_count > 0)
);

create index if not exists idx_singles_batches_user on public.singles_batches(user_id);
create index if not exists idx_singles_batches_run on public.singles_batches(run_id);

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'stores') then
    if not exists (select 1 from pg_constraint where conname = 'singles_batches_store_id_fkey') then
      alter table public.singles_batches
        add constraint singles_batches_store_id_fkey foreign key (store_id) references public.stores(id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. shipment_verifications.source — how this box came to be credited.
--
--    NULL / 'scan'   = the normal pack-station confirm. EVERY existing row means this.
--    'singles_batch' = credited by scanning a finished singles header slip.
--
--    Not cosmetic. The picker work model (~47.5s per box + ~17.3s per item, fitted over 8,677
--    boxes — see src/lib/shipping/crewBoard.ts) was measured on the REGULAR pick flow: walking
--    racks, finding items, combining orders. The singles station is batch assembly from one
--    carton and is far faster per package. 500 singles x 65s would be 9 hours — longer than the
--    shift — so applying the picking weight to singles would over-credit them roughly 2-3x. This
--    column keeps singles identifiable so they are reported on their own line and NEVER silently
--    inherit that weight, until there is real scan data to calibrate seconds-per-single.
--
--    Nullable with NO default on purpose: a default would rewrite the table on older servers, and
--    every existing row already means 'scan'. Readers MUST treat NULL as 'scan'.
-- ---------------------------------------------------------------------------
alter table public.shipment_verifications add column if not exists source text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shipment_verifications_source_check') then
    alter table public.shipment_verifications
      add constraint shipment_verifications_source_check
      check (source is null or source in ('scan', 'singles_batch'));
  end if;
end $$;

-- The board and the cost math both need "singles credited in this window". Singles are a minority
-- of rows, so a partial index stays small.
create index if not exists idx_shipment_verifications_singles
  on public.shipment_verifications (user_id, verified_at) where source = 'singles_batch';

-- ---------------------------------------------------------------------------
-- 3. RLS — own-row (auth.uid() = user_id), the 070/044/091/146 idiom. These govern OWNER access
--    from the dashboard. The station scan runs under the packer's own session and the credit write
--    is service-role scoped explicitly by the resolved owner — RLS is not the boundary there.
-- ---------------------------------------------------------------------------
alter table public.singles_batches enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='singles_batches' and policyname='Users can view own singles_batches') then
    create policy "Users can view own singles_batches" on public.singles_batches
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='singles_batches' and policyname='Users can insert own singles_batches') then
    create policy "Users can insert own singles_batches" on public.singles_batches
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='singles_batches' and policyname='Users can update own singles_batches') then
    create policy "Users can update own singles_batches" on public.singles_batches
      for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='singles_batches' and policyname='Users can delete own singles_batches') then
    create policy "Users can delete own singles_batches" on public.singles_batches
      for delete using (auth.uid() = user_id);
  end if;
end $$;
