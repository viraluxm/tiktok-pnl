-- 148_singles_batches_span_runs.sql
-- Re-shape singles_batches: a pile is the SET OF LABELS a header slip fronts, not one run.
--
-- WHY. 147 keyed a batch on (run_id, slip_caption). That was wrong for how labels are actually
-- printed here: labels are bought per shop and then printed COMBINED, so one singles pile routinely
-- draws from a dozen runs. Measured over the 4 days to 2026-09-09:
--     #271 JUMBO STRAWBERRY SQUEEZE   13 runs,  95 labels
--     #428 CRUNCHY SOAP BAR ORIGINAL  12 runs, 148 labels
--     #384 VASELINE BUTTER IN BOX     12 runs, 115 labels
-- Under 147 a merged print could not be given an honest code — one slip would have fronted labels
-- from twelve batches — so the barcode was suppressed. That meant NO barcode on essentially every
-- real print: the feature would have shipped doing nothing.
--
-- THE FIX. Store the pile's member boxes directly. The slip fronts exactly those labels, so that
-- is what a batch is. Runs stop being part of the batch's identity entirely, and merged and
-- single-run prints become the same case with no special path to get wrong.
--
-- ⚠️ MIGRATION LEDGER: no ledger; applied BY HAND; this file is the only record. Prefix 148 chosen
--    after `git fetch --all` + a full scan of tracked files, both working trees and every branch
--    (145 practice_host_token, 146 crew_board_tokens, 147 singles_batches).
--    ➜ BEFORE HAND-APPLYING: confirm singles_batches still has a `run_id` column and NO
--      `group_keys` column, i.e. that 147 ran and this has not.
--
-- LOCK FOOTPRINT: singles_batches ONLY. Nothing reads or writes it yet — the feature that
-- populates it is unmerged and the table is empty — so this locks nothing in use and touches no
-- table on the capture, order-sync or packing path. Safe at any time.

-- ---------------------------------------------------------------------------
-- 1. The pile's member boxes. `group_key` matches shipment_verifications.group_key exactly
--    ('trk:<tracking>'), so crediting a batch is a direct insert with no lookup.
--
--    NOT NULL with no default is safe: the table is empty (verified: 0 rows) and nothing writes
--    it yet. If that is somehow untrue where you are running this, back the rows up first —
--    this statement will fail rather than invent data.
-- ---------------------------------------------------------------------------
alter table public.singles_batches add column if not exists group_keys text[] not null default '{}';
alter table public.singles_batches alter column group_keys drop default;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'singles_batches_group_keys_present') then
    alter table public.singles_batches
      add constraint singles_batches_group_keys_present check (array_length(group_keys, 1) > 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Runs leave the batch's identity.
--
--    run_ids is kept as PROVENANCE ONLY — useful when tracing a pile back to the purchases that
--    made it — but nothing resolves a scan through it, so a pile spanning twelve runs is no
--    different from one spanning a single run.
--
--    The (run_id, slip_caption) uniqueness goes with it. Re-printing a stack now mints a NEW batch
--    with its own code; both codes resolve to the same boxes and the DB's
--    UNIQUE (user_id, group_key) on shipment_verifications still makes the second scan a no-op.
--    That is strictly safer than trying to reuse a code across prints whose contents differ.
-- ---------------------------------------------------------------------------
alter table public.singles_batches drop constraint if exists singles_batches_run_caption_key;

alter table public.singles_batches add column if not exists run_ids uuid[];

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'singles_batches' and column_name = 'run_id') then
    -- Empty table, so there is nothing to carry across; drop rather than backfill.
    alter table public.singles_batches drop column run_id;
  end if;
end $$;

drop index if exists public.idx_singles_batches_run;
create index if not exists idx_singles_batches_created on public.singles_batches(user_id, created_at desc);
