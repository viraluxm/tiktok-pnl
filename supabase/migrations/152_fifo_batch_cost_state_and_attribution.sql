-- 152: FIFO foundation — explicit batch cost state + permanent source-batch attribution.
--
-- SCHEMA ONLY. Applying THIS FILE ALONE changes no behaviour anywhere: every column is
-- additive, every existing row keeps a value that asserts nothing new, and nothing reads
-- or writes the new columns until migration 153 replaces the RPCs. That ordering is
-- deliberate and is the same one migration 104 used for short_at_bind — column first
-- (inert), RPCs second. The reverse ordering is impossible: 153 cannot be applied against
-- a table without these columns.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────
-- Two facts are currently unrecoverable from this database, and both are needed before a
-- batch's cost can ever be corrected after the fact:
--
--   1. WHICH BATCH DID THIS SALE CONSUME?  lensed_log_auction picks a single FIFO layer,
--      decrements its qty_remaining, copies its unit_cost_cents into
--      live_auction_item_skus.unit_cost_cents_snapshot — and then DISCARDS the batch id.
--      It lives only in a plpgsql local (v_batch). There are ZERO foreign keys pointing at
--      sku_batches in production. So a cost correction has no set of rows to correct: you
--      cannot find the units that came from the batch you just re-priced.
--
--   2. IS THIS COST KNOWN, OR JUST NOT ENTERED YET?  unit_cost_cents = 0 is accepted
--      everywhere with no warning and is indistinguishable from genuinely free inventory.
--      Because 0 is not NULL it wins the canonical COGS expression
--      `coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)` and freezes at zero
--      forever. NULL behaves completely differently — it falls through to the SKU scalar,
--      which an undocumented per-minute cron rewrites from the current front layer (see
--      docs/runbooks/prod-only-cost-objects.md). One placeholder, two opposite outcomes,
--      neither of them a deliberate choice.
--
-- This migration records both facts going forward. It corrects nothing historical, and it
-- invents nothing about the past.
--
-- ── WHAT THIS FILE DOES NOT DO ────────────────────────────────────────────────────────
--   • No backfill. All 178,632 existing sale lines keep source_batch_id NULL — honestly
--     unattributed, because the information to attribute them was never recorded. Any
--     heuristic (matching on snapshot value) would be a guess presented as a fact.
--   • No re-pricing. unit_cost_cents_snapshot is not touched, by this file or by 153.
--   • No data mutation. Existing sku_batches rows are classified 'legacy', which asserts
--     only that we do not know — see the cost_status vocabulary below.
--   • No change to the prod-only cost-mirror cron. It is documented, not modified.

-- ══ 1. sku_batches.cost_status — is this cost KNOWN? ═══════════════════════════════════
--
-- VOCABULARY (three states, one of which exists solely to avoid lying about the past):
--
--   'legacy'  — this row predates the cutover. We do NOT assert whether its cost is known,
--               deliberate, or a placeholder. Existing NULL-cost and $0-cost rows both land
--               here, and that is the honest classification: migration 083 already refused
--               to invent history for qty_added, and the same discipline applies to cost.
--   'pending' — cost is NOT yet known. unit_cost_cents IS NULL.
--   'final'   — cost is known and asserted. unit_cost_cents IS NOT NULL, INCLUDING 0.
--
-- A genuine $0 is therefore representable for the first time: (0, 'final') is "this really
-- was free", while (NULL, 'pending') is "we haven't priced it yet". Today those two are the
-- same row.
--
-- WHY A 'legacy' STATE RATHER THAN A NULLABLE COLUMN. A nullable cost_status would put a
-- second, differently-meaning NULL in the same row as unit_cost_cents — exactly the
-- ambiguity this column exists to remove. An explicit token is greppable, self-documenting,
-- and lets the CHECK below be total. NOT NULL DEFAULT is metadata-only on PG 11+, so no
-- table rewrite.
--
-- WHY DEFAULT 'legacy' AND NOT 'final'. Production holds 8 batches with unit_cost_cents
-- NULL and 1 with 0. Defaulting to 'final' would assert that those nine costs are settled
-- facts; three of the NULL ones have already sold units. 'legacy' is also the safe failure
-- mode for any INSERT path that is added later and forgets to set the column: it degrades
-- to "unknown", never to a false assertion.
alter table public.sku_batches
  add column if not exists cost_status text not null default 'legacy';

-- The invariant that makes the column trustworthy for every NEW row, while leaving every
-- legacy row unconstrained. All 790 existing rows are 'legacy' and satisfy branch 1, so
-- this validates without touching data.
alter table public.sku_batches
  drop constraint if exists sku_batches_cost_status_chk;
alter table public.sku_batches
  add constraint sku_batches_cost_status_chk check (
        cost_status = 'legacy'
    or (cost_status = 'pending' and unit_cost_cents is null)
    or (cost_status = 'final'   and unit_cost_cents is not null)
  );

comment on column public.sku_batches.cost_status is
  'Is this layer''s unit_cost_cents a KNOWN cost? ''final'' = yes (including a genuine 0); '
  '''pending'' = not entered yet (unit_cost_cents IS NULL); ''legacy'' = pre-dates migration '
  '152, meaning is unproven and is deliberately not asserted. Enforced by '
  'sku_batches_cost_status_chk. Set by lensed_add_batch / lensed_add_batch_admin / the '
  'create-SKU seed / lensed_unbind restock (153); moved by lensed_edit_batch only when the '
  'caller explicitly sets a cost.';

-- ══ 2. sku_batches.qty_added_authoritative — is qty_added the ORIGINAL RECEIPT? ════════
--
-- qty_added already exists but its meaning is NOT uniform, so it cannot simply be promoted
-- to "original quantity received":
--
--   • Legacy rows were never backfilled — migration 083 says so explicitly and gives the
--     reason: setting qty_added = qty_remaining on a partly-sold layer would misclassify a
--     consumed layer as untouched. Many legacy rows are NULL; the non-NULL ones have no
--     provenance guarantee.
--   • lensed_edit_batch RE-BASES qty_added to the new quantity whenever the layer is
--     "untouched" (qty_added IS NOT NULL AND qty_remaining = qty_added). On a post-cutover
--     batch that is precisely the silent rewrite of receipt history we must prevent:
--     receive 500, correct current stock to 450, and the record that 500 ever arrived is
--     gone.
--
-- So the distinction is carried by a separate boolean rather than inferred:
--   true  ⇒ this row was created after the cutover by a path that stamps the received
--           quantity, and qty_added means ORIGINAL QUANTITY RECEIVED. Migration 153 makes
--           lensed_edit_batch refuse to re-base it.
--   false ⇒ legacy. qty_added keeps exactly today's meaning and today's behaviour,
--           re-basing included. Nothing about existing rows changes.
--
-- WHY NOT REUSE cost_status <> 'legacy' AS THE CUTOVER MARKER. Cost certainty and quantity
-- provenance are orthogonal facts. lensed_edit_batch (153) moves a legacy row's cost_status
-- to 'final' when a human enters a cost — which must NOT simultaneously start asserting
-- that its qty_added is a trustworthy receipt. Conflating the two would re-create, in a new
-- column, the exact class of ambiguity this migration exists to remove.
alter table public.sku_batches
  add column if not exists qty_added_authoritative boolean not null default false;

-- An authoritative receipt quantity must actually exist. Every current row is false, so
-- this validates without touching data.
alter table public.sku_batches
  drop constraint if exists sku_batches_qty_added_authoritative_chk;
alter table public.sku_batches
  add constraint sku_batches_qty_added_authoritative_chk
  check (not qty_added_authoritative or qty_added is not null);

comment on column public.sku_batches.qty_added_authoritative is
  'true = qty_added is the ORIGINAL QUANTITY RECEIVED into this layer, stamped at creation '
  'by a post-152 path, and lensed_edit_batch will never re-base it. false = legacy row: '
  'qty_added keeps its pre-152 meaning (possibly NULL, possibly re-based by an earlier '
  'edit) and its pre-152 behaviour. Consumed units are derived as '
  'qty_added - qty_remaining, and ONLY when this flag is true.';

-- ══ 3. live_auction_item_skus.source_batch_id — WHICH layer did this line consume? ═════
--
-- The order-line grain is already correct for this: one row per
-- (auction_item_id, inventory_sku_id), and lensed_log_auction draws exactly one batch per
-- line (it selects the oldest layer that covers the WHOLE line quantity — "Option X" — so a
-- line is never split across layers). One nullable uuid is therefore a complete record of
-- the allocation, with no ledger table required.
--
-- NULL is permanent and honest for every pre-152 row: it means "bound before attribution
-- existed", not "no batch". Nothing is backfilled.
alter table public.live_auction_item_skus
  add column if not exists source_batch_id uuid;

-- ── FK: ON DELETE NO ACTION (NOT set null, NOT cascade) ───────────────────────────────
--
-- The whole point of this column is permanent provenance, so a rule that quietly erases it
-- is disqualified:
--   • SET NULL would destroy the attribution at exactly the moment someone removes the
--     batch — deleting the evidence instead of refusing the delete.
--   • CASCADE would delete the SALE. Never.
--
-- NO ACTION vs RESTRICT — NO ACTION, deliberately. Both reject a delete that would orphan a
-- reference; they differ only in WHEN the check fires. RESTRICT fires the instant the
-- parent row is deleted; NO ACTION defers to the end of the statement. That matters because
-- sku_batches.user_id and live_auction_item_skus.user_id BOTH cascade from auth.users(id).
-- A single `delete from auth.users` therefore removes parent and child in one statement,
-- and RESTRICT could fire mid-statement on a parent whose child is about to disappear
-- anyway. NO ACTION lets the statement settle and then checks — same protection, no
-- spurious failure. (In practice account deletion is already blocked for any user with sale
-- history by the pre-existing live_auction_item_skus.inventory_sku_id -> inventory_skus
-- ON DELETE RESTRICT, so this choice adds no new failure mode; it merely avoids adding a
-- second, earlier-firing one.)
--
-- NOT VALID + VALIDATE, in two statements, because live_auction_item_skus is a hot
-- capture-path table with 178,632 rows.
--
-- LOCKS, stated precisely (an earlier draft of this comment understated them):
--   • ADD CONSTRAINT ... NOT VALID does NOT scan, but it takes SHARE ROW EXCLUSIVE on BOTH
--     the child (live_auction_item_skus) AND the referenced parent (sku_batches) — the
--     parent lock is needed to install the RI triggers. sku_batches is the hot FIFO table,
--     so this briefly blocks INSERT/UPDATE/DELETE on the very table a live draw writes.
--     It does not block SELECT, and it is instant because nothing is scanned.
--   • VALIDATE CONSTRAINT scans all 178,632 rows but under SHARE UPDATE EXCLUSIVE on the
--     child + ROW SHARE on the parent, which blocks NEITHER reads NOR writes.
-- So the write-blocking part is instant and the scanning part is non-blocking — which is
-- the whole reason for splitting them. It still belongs in a write-silence window because
-- of the parent-side lock, not because of the scan.
alter table public.live_auction_item_skus
  drop constraint if exists live_auction_item_skus_source_batch_id_fkey;
alter table public.live_auction_item_skus
  add constraint live_auction_item_skus_source_batch_id_fkey
  foreign key (source_batch_id) references public.sku_batches(id)
  on delete no action
  not valid;
alter table public.live_auction_item_skus
  validate constraint live_auction_item_skus_source_batch_id_fkey;

-- Partial index: batch -> its sale lines. This is the lookup the future finalize-cost RPC
-- performs ("reprice every line drawn from batch B"), and the one an audit performs. It is
-- partial because every pre-152 row is NULL and indexing 178k NULLs would be pure waste —
-- the index starts at zero entries and grows only with newly attributed lines.
--
-- Plain CREATE INDEX rather than CONCURRENTLY — and the cost of that is a real, if short,
-- write block, NOT "instant". A partial predicate is a filter, not an access path: the build
-- still performs a full heap scan of all 178,632 rows to evaluate `source_batch_id is not
-- null` per tuple, even though the resulting index has zero entries. It holds SHARE on
-- live_auction_item_skus for that scan, which blocks every INSERT/UPDATE/DELETE on the table
-- (SELECTs are unaffected). On a table this size that is well under a second, and it is
-- inside the write-silence window regardless.
--
-- CONCURRENTLY is deliberately NOT used, because it cannot run inside a transaction — and
-- applying 152 + 153 + 154 as ONE transaction is worth more than avoiding a sub-second write
-- block: it makes the intermediate states (152 without 153) unobservable, which is what stops
-- batches being created with default 'legacy' / non-authoritative values that nothing ever
-- corrects. If this is ever applied to a table where the predicate matches many rows, revisit.
create index if not exists idx_live_auction_item_skus_source_batch
  on public.live_auction_item_skus (source_batch_id)
  where source_batch_id is not null;

comment on column public.live_auction_item_skus.source_batch_id is
  'The sku_batches layer this order line actually consumed, recorded by lensed_log_auction '
  '/ lensed_log_auction_as at bind time (migration 153). Immutable provenance: set once when '
  'the draw happens, never recomputed. NULL = bound before migration 152 shipped, or the '
  'line was not a sale (not_sold draws nothing) — NEVER "no batch". Deliberately NOT '
  'backfilled: the pre-152 draw discarded the batch id, so any reconstruction would be a '
  'guess. ON DELETE NO ACTION, so a consumed layer can no longer be deleted out from under '
  'its sales.';

-- ── RLS / grants: unchanged, and nothing to change ────────────────────────────────────
-- Both tables keep their existing policies verbatim: live_auction_item_skus is owner-scoped
-- (auth.uid() = user_id, four policies) and sku_batches is org-scoped (is_org_member(org_id),
-- four policies). Adding a column inherits them; column-level grants are not in use on
-- either table. The new FK's referential check runs as an internal RI trigger with the
-- table owner's rights and is NOT subject to RLS, so a member binding a sale can reference
-- an org batch exactly as the draw already does. No policy, grant or role is touched here.
