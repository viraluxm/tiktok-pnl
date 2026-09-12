-- 154: enter or correct a batch's true unit cost ONCE, and carry it back through every
-- sale that batch actually supplied. REQUIRES 152 + 153.
--
-- This is the stage 152/153 were built for. 152 recorded WHICH layer each sale consumed;
-- 153 started writing it. Neither changed a single historical cost. This migration is the
-- operation that does — deliberately, atomically, audibly, and only over rows whose
-- attribution was genuinely recorded.
--
-- ── THE WORKFLOW THIS MAKES SAFE ──────────────────────────────────────────────────────
--   add 500 units, cost unknown        -> unit_cost_cents NULL, cost_status 'pending'
--   sell 120 over the next week        -> 120 lines carry source_batch_id = this layer
--   learn the cost is $3.40            -> lensed_finalize_batch_cost(sku, batch, 340)
--   result: those 120 lines now read 340; the 380 still on the layer are priced 340 for
--           future draws; qty_added stays 500; nothing moved in inventory.
--
-- The same call corrects an already-known cost ($3.40 -> $3.55). There is deliberately NO
-- separate accounting path for the two: both mean "this layer's true unit cost is now X",
-- and both must reprice exactly the same set of rows. A single operation is also the only
-- way to keep the audit trail meaningful — two code paths would mean two ways to be wrong.
--
-- ── WHAT IT REFUSES TO GUESS ──────────────────────────────────────────────────────────
-- Only layers with qty_added_authoritative = true are finalizable. A legacy layer's sales
-- have source_batch_id NULL — the pre-152 draw discarded the id — so there is no set of
-- rows to reprice, and there is no honest way to find one. Matching on snapshot value or
-- replaying FIFO quantities would both be guesses presented as facts. The RPC raises
-- BATCH_NOT_ATTRIBUTABLE rather than silently repricing nothing (or, worse, something).
--
-- ── WHAT IT NEVER TOUCHES ─────────────────────────────────────────────────────────────
-- qty_added, qty_remaining, inventory_skus.qty_on_hand, sequence, source_batch_id. A cost
-- correction is not an inventory movement. The only quantity-adjacent write in this file is
-- the SKU cost SCALAR mirror in step 6, which is a cost, not a quantity.
--
-- ── CLASS ─────────────────────────────────────────────────────────────────────────────
-- CLASS B per CLAUDE.md: CREATE OR REPLACE on functions the live path calls, plus one new
-- table. Needs a write-silence window. Grants restated per CONVENTIONS.md.

-- ══ 1. sku_batch_cost_revisions — the immutable record of every cost change ════════════
--
-- One row per revision that actually changed something. It answers, months later and
-- without re-deriving anything: which batch, which SKU, from what, to what, by whom, when,
-- how many sale lines and units moved, and what it did to COGS.
--
-- prev/new/delta COGS are STORED rather than derived on demand. That is not duplicated
-- business data: once the snapshots have moved on, the COGS that a PARTICULAR revision
-- displaced cannot be recovered from any other row — especially where the layer was pending
-- and the prior snapshots were NULL. The measured effect of an event belongs with the event.
--
-- ON DELETE CASCADE on batch_id is safe by construction, not by luck: step 4 below refuses
-- to delete any layer that has attributed sales, and 152's FK enforces the same thing at the
-- database. So the only batch that can ever be deleted is one with ZERO attributed lines,
-- whose revisions therefore all have lines_repriced = 0 and cogs_delta_cents = 0. Cascading
-- those away removes no accounting history.
create table if not exists public.sku_batch_cost_revisions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  sku_id uuid not null references public.inventory_skus(id) on delete cascade,
  batch_id uuid not null references public.sku_batches(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  -- NULL = the layer was 'pending' (cost had never been entered). Not the same as 0.
  old_unit_cost_cents integer,
  new_unit_cost_cents integer not null,
  -- Sale lines whose snapshot actually MOVED (not merely attributed).
  lines_repriced integer not null,
  units_repriced integer not null,
  -- COGS across ALL lines attributed to this batch, before and after. Unknown (NULL)
  -- snapshots count as 0, matching how pnl_by_sku reads them.
  prev_cogs_cents bigint not null,
  new_cogs_cents bigint not null,
  cogs_delta_cents bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sku_batch_cost_revisions_batch
  on public.sku_batch_cost_revisions (batch_id, created_at desc);
create index if not exists idx_sku_batch_cost_revisions_org
  on public.sku_batch_cost_revisions (org_id, created_at desc);

alter table public.sku_batch_cost_revisions enable row level security;

-- Org-scoped SELECT + INSERT only, mirroring sku_batches. There is deliberately NO update
-- and NO delete policy: a revision is append-only from the application's point of view, and
-- a second correction appends a second row rather than overwriting the first.
drop policy if exists sku_batch_cost_revisions_org_sel on public.sku_batch_cost_revisions;
create policy sku_batch_cost_revisions_org_sel on public.sku_batch_cost_revisions
  for select using (public.is_org_member(org_id));
drop policy if exists sku_batch_cost_revisions_org_ins on public.sku_batch_cost_revisions;
create policy sku_batch_cost_revisions_org_ins on public.sku_batch_cost_revisions
  for insert with check (public.is_org_member(org_id));

comment on table public.sku_batch_cost_revisions is
  'Append-only audit of every lensed_finalize_batch_cost call that changed something. No '
  'update/delete policy by design: a later correction appends a new row. A true no-op '
  '(same cost, nothing to reprice) records NOTHING — see the RPC header.';

-- ══ 2. lensed_finalize_batch_cost — the ONE cost-change operation ══════════════════════
--
-- Atomic by construction: one plpgsql function = one transaction from the caller's side, so
-- the batch write, the snapshot reprice, the scalar mirror and the audit row all commit
-- together or not at all.
--
-- IDEMPOTENCY (deliberate decision, Option A). Calling it twice with the same cost is a
-- success that records NOTHING the second time: the reprice UPDATE is guarded by
-- `is distinct from`, so it touches zero rows, and the revision row is written only when the
-- cost changed OR rows actually moved. Nothing doubles, because nothing about the operation
-- accumulates — it SETS a cost and SETS snapshots, it never adds. The returned
-- revision_recorded flag lets a caller tell a real correction from a replay.
--
--   Why the no-op test is "cost unchanged AND zero rows moved", not just "cost unchanged":
--   a layer can be at 340 while some of its attributed lines still read something else — for
--   instance rows bound before this migration shipped, or after a pre-154 edit moved the cost
--   without repricing. Testing only the cost would declare that divergence a no-op and leave
--   it uncorrected. Testing the rows repairs it and records the repair.
--
-- ORDERING inside the lock matters: measure -> write cost -> reprice -> measure -> mirror ->
-- audit. Measuring the "before" figure after the write would report the new cost as if it had
-- always been there.
create or replace function public.lensed_finalize_batch_cost(
  p_sku_id uuid,
  p_batch_id uuid,
  p_unit_cost_cents int
)
returns table (
  batch_id uuid,
  old_unit_cost_cents int,
  new_unit_cost_cents int,
  lines_repriced int,
  units_repriced int,
  prev_cogs_cents bigint,
  new_cogs_cents bigint,
  cogs_delta_cents bigint,
  revision_recorded boolean,
  sku_cost_scalar_updated boolean
)
language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_sku uuid; v_old int; v_auth boolean;
  v_lines int; v_units int;
  v_all_units bigint; v_prev bigint; v_new bigint;
  v_front int; v_scalar boolean := false; v_rev boolean := false;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org  is null then raise exception 'NO_ORG' using errcode='P0001'; end if;

  -- A finalized cost must BE a cost. Blanking one is not a correction — it is un-knowing
  -- something, which lensed_edit_batch already expresses for legacy layers and which has no
  -- meaning once sales have been priced from it.
  if p_unit_cost_cents is null then raise exception 'COST_REQUIRED' using errcode='22023'; end if;
  if p_unit_cost_cents < 0 then raise exception 'INVALID_COST' using errcode='22023'; end if;

  -- Batch must belong to BOTH the named SKU and the caller's org — same defence in depth as
  -- lensed_edit_batch, and it rejects a wrong sku/batch pairing as well as a cross-org id.
  select b.sku_id into v_sku
    from public.sku_batches b
   where b.id = p_batch_id and b.org_id = v_org and b.sku_id = p_sku_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- THE SAME per-SKU key a live sale, an add, an edit, a settle and a delete all take. A
  -- draw therefore cannot interleave with a reprice: a sale either commits first and is
  -- repriced by this call, or waits and snapshots the finalized cost directly. There is no
  -- third outcome, which is exactly the invariant the concurrency test asserts.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));

  -- Re-read under the lock. Anything decided from a pre-lock read is a race.
  select b.unit_cost_cents, b.qty_added_authoritative into v_old, v_auth
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

  -- Legacy layers have no attributed sales and never will. Refuse loudly rather than
  -- "succeed" having repriced nothing, which would read as a working correction.
  if not coalesce(v_auth, false) then
    raise exception 'BATCH_NOT_ATTRIBUTABLE' using errcode='P0001';
  end if;

  -- ── measure BEFORE (all attributed lines; unknown snapshots count as 0, as pnl_by_sku does)
  select coalesce(sum(l.qty * coalesce(l.unit_cost_cents_snapshot, 0)), 0)::bigint,
         coalesce(sum(l.qty), 0)::bigint
    into v_prev, v_all_units
    from public.live_auction_item_skus l
   where l.source_batch_id = p_batch_id;

  -- ── how much is actually about to move (counted before the UPDATE, under the lock)
  select count(*)::int, coalesce(sum(l.qty), 0)::int
    into v_lines, v_units
    from public.live_auction_item_skus l
   where l.source_batch_id = p_batch_id
     and l.unit_cost_cents_snapshot is distinct from p_unit_cost_cents;

  -- ── 1. the layer itself: future draws price from here.
  -- The guard trigger installed below refuses ANY change to an attributable layer's cost
  -- that does not carry this transaction-local marker. Setting it here is what makes this
  -- function the single sanctioned writer; it is scoped to the statement pair and cleared
  -- immediately, so nothing else in this transaction inherits the permission.
  perform set_config('lensed.batch_cost_write', '1', true);
  update public.sku_batches b
     set unit_cost_cents = p_unit_cost_cents,
         cost_status = 'final'
   where b.id = p_batch_id and b.org_id = v_org;
  perform set_config('lensed.batch_cost_write', '', true);

  -- ── 2. history: ONLY rows this batch actually supplied. source_batch_id is the whole
  --      guarantee — no SKU-wide sweep, no date range, no cost matching. Rows already at the
  --      target value are skipped so a replay moves nothing.
  update public.live_auction_item_skus l
     set unit_cost_cents_snapshot = p_unit_cost_cents
   where l.source_batch_id = p_batch_id
     and l.unit_cost_cents_snapshot is distinct from p_unit_cost_cents;

  v_new := v_all_units * p_unit_cost_cents;

  -- ── 3. mirror the SKU cost scalar, replicating lensed_recompute_sku_cost_scalar exactly
  --      (see docs/runbooks/prod-only-cost-objects.md) but scoped to this one SKU:
  --        • the FRONT layer = oldest sequence with qty_remaining > 0
  --        • PRESERVE: never write NULL
  --        • idempotent: only write when it differs
  --      Without this the scalar disagrees with the layer for up to 60 seconds after a
  --      correction, and that scalar is the COGS fallback for every un-attributed line plus
  --      the basis of the Inventory value figure. Doing it here makes the cron's next run a
  --      no-op rather than a delayed second source of truth.
  select b.unit_cost_cents into v_front
    from public.sku_batches b
   where b.sku_id = v_sku and b.qty_remaining > 0
   order by b.sequence asc
   limit 1;
  if v_front is not null then
    update public.inventory_skus s
       set unit_cost_cents = v_front
     where s.id = v_sku and s.org_id = v_org
       and s.unit_cost_cents is distinct from v_front;
    if found then v_scalar := true; end if;
  end if;

  -- ── 4. audit, unless this was a genuine no-op
  if v_old is distinct from p_unit_cost_cents or v_lines > 0 then
    insert into public.sku_batch_cost_revisions
      (org_id, sku_id, batch_id, actor_user_id, old_unit_cost_cents, new_unit_cost_cents,
       lines_repriced, units_repriced, prev_cogs_cents, new_cogs_cents, cogs_delta_cents)
    values
      (v_org, v_sku, p_batch_id, v_user, v_old, p_unit_cost_cents,
       v_lines, v_units, v_prev, v_new, v_new - v_prev);
    v_rev := true;
  end if;

  batch_id := p_batch_id;
  old_unit_cost_cents := v_old;
  new_unit_cost_cents := p_unit_cost_cents;
  lines_repriced := v_lines;
  units_repriced := v_units;
  prev_cogs_cents := v_prev;
  new_cogs_cents := v_new;
  cogs_delta_cents := v_new - v_prev;
  revision_recorded := v_rev;
  sku_cost_scalar_updated := v_scalar;
  return next;
end;
$$;

comment on function public.lensed_finalize_batch_cost(uuid, uuid, int) is
  'Set a post-152 batch''s true unit cost and reprice every sale line attributed to it '
  '(source_batch_id), atomically, with an audit row. Handles pending->final and '
  'final->corrected identically. Never touches quantities. Refuses legacy layers '
  '(BATCH_NOT_ATTRIBUTABLE) because their sales carry no attribution to reprice.';

-- ══ 3. lensed_edit_batch — close the bypass ════════════════════════════════════════════
-- Baseline: the migration-153 body (153 is not yet applied to production, so prod prosrc is
-- NOT the baseline here — 153 is). Single edit: refuse a real cost CHANGE on an
-- attributable layer, so there are not two ways to move a cost where only one fixes history.

CREATE OR REPLACE FUNCTION public.lensed_edit_batch(p_sku_id uuid, p_batch_id uuid, p_qty_remaining integer, p_unit_cost_cents integer, p_set_cost boolean DEFAULT true)
 RETURNS TABLE(batch_id uuid, new_qty_remaining integer, new_qty_added integer, new_unit_cost_cents integer, new_qty_on_hand integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_old int; v_added int; v_new_added int; v_was_untouched boolean;
  v_auth boolean;   -- 153: is qty_added the authoritative original receipt?
  v_cur_cost int;   -- 154: current cost, to tell a real change from a re-submit
  v_delta int; v_qoh int; v_final_cost int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  -- Remaining qty: integer >= 0. (Original qty is never edited by hand here.)
  if p_qty_remaining is null or p_qty_remaining < 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  -- Cost (only when actually being set): null (unknown) or a nonnegative integer —
  -- matches lensed_add_batch conventions.
  if p_set_cost and p_unit_cost_cents is not null and p_unit_cost_cents < 0 then
    raise exception 'INVALID_COST' using errcode='22023';
  end if;

  -- Batch must belong to BOTH the requested SKU and the caller's org (defense in
  -- depth beyond RLS; also rejects a wrong sku/batch pairing and cross-org ids).
  select b.sku_id into v_sku
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = v_org and b.sku_id = p_sku_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against live sales / add / settle on this SKU, THEN read fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select b.qty_remaining, b.qty_added, b.qty_added_authoritative, b.unit_cost_cents
    into v_old, v_added, v_auth, v_cur_cost
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

  -- 154: ONE COST PATH FOR ATTRIBUTABLE BATCHES.
  -- A post-cutover layer's sales carry source_batch_id, so its cost can be corrected
  -- everywhere at once by lensed_finalize_batch_cost. If this RPC were also allowed to
  -- change the cost it would move the layer WITHOUT repricing those sales, leaving the
  -- batch and its own history disagreeing — the precise failure 154 exists to end. So a
  -- real cost CHANGE on an authoritative layer is refused here and must go through
  -- finalize. Re-submitting the SAME cost is not a change and stays allowed, which is what
  -- keeps the ordinary quantity edit working: the inline form posts the unchanged cost
  -- alongside the new quantity. Legacy layers (qty_added_authoritative = false) have no
  -- attribution to reprice, so they keep the pre-154 behaviour untouched.
  if p_set_cost and coalesce(v_auth, false)
     and p_unit_cost_cents is distinct from v_cur_cost then
    raise exception 'COST_EDIT_REQUIRES_FINALIZE' using errcode='P0001';
  end if;

  -- Untouched BEFORE the edit ⇒ re-base qty_added with the correction so it stays
  -- untouched. Otherwise keep qty_added EXACTLY (legacy NULL stays NULL; a consumed
  -- original is never rewritten).
  -- 153: an AUTHORITATIVE qty_added is the ORIGINAL QUANTITY RECEIVED and is never re-based
  -- by an ordinary current-stock correction. Receive 500, correct stock to 450, and the row
  -- still says 500 arrived. Legacy layers (qty_added_authoritative = false) keep the exact
  -- pre-153 behaviour, including the re-base, so nothing about existing data changes.
  v_was_untouched := (not coalesce(v_auth, false) and v_added is not null and v_old = v_added);
  v_new_added := case when v_was_untouched then p_qty_remaining else v_added end;
  v_delta := p_qty_remaining - v_old;

  update public.sku_batches b
     set qty_remaining = p_qty_remaining,
         qty_added = v_new_added,
         unit_cost_cents = case when p_set_cost then p_unit_cost_cents else b.unit_cost_cents end,
         -- 153: setting a cost RESOLVES its certainty, so the state moves with it — blank to
         -- 'pending', any number (including 0) to 'final'. This also lifts a legacy row out of
         -- 'legacy' once a human asserts its cost, and it is what keeps
         -- sku_batches_cost_status_chk true by construction. A qty-only edit (p_set_cost false)
         -- leaves cost AND state untouched.
         cost_status = case when p_set_cost
                            then (case when p_unit_cost_cents is null then 'pending' else 'final' end)
                            else b.cost_status end
     where b.id = p_batch_id and b.org_id = v_org
     returning b.unit_cost_cents into v_final_cost;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + v_delta
     where s.id = v_sku and s.org_id = v_org
     returning s.qty_on_hand into v_qoh;

  batch_id := p_batch_id; new_qty_remaining := p_qty_remaining; new_qty_added := v_new_added;
  new_unit_cost_cents := v_final_cost; new_qty_on_hand := v_qoh;
  return next;
end;
$function$;

-- ══ 4. lensed_delete_batch — a friendly answer instead of a raw 23503 ══════════════════
-- Baseline: production (neither 153 nor anything else redefined this function).
CREATE OR REPLACE FUNCTION public.lensed_delete_batch(p_sku_id uuid, p_batch_id uuid)
 RETURNS TABLE(deleted_batch_id uuid, deleted_qty integer, new_qty_on_hand integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_rem int; v_added int; v_count int; v_qoh int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;

  select b.sku_id into v_sku
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = v_org and b.sku_id = p_sku_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against live sales / add / settle on this SKU, THEN read fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select b.qty_remaining, b.qty_added into v_rem, v_added
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

  -- Untouched iff we KNOW its original qty and none has been drawn. Legacy NULL rows
  -- and any partly/over-consumed layer are refused with a single clear conflict.
  if v_added is null or v_rem <> v_added then
    raise exception 'BATCH_NOT_DELETABLE' using errcode='P0001';
  end if;

  -- 154: FRIENDLY PRE-CHECK, ahead of the database's last word.
  -- The untouched proof above is DEFEATABLE: lensed_edit_batch evaluates untouched-ness on
  -- the PRE-edit state, so raising qty_remaining back up to equal qty_added makes a layer
  -- that HAS been drawn from look pristine again. 152's FK then refuses the delete — but as
  -- a raw 23503 foreign_key_violation, which the route can only render as a generic 500.
  -- This check asks the real question directly, in the same locked transaction, and answers
  -- it with a domain error the UI can explain. The FK is NOT weakened: it remains the final
  -- invariant, and still fires if anything reaches a DELETE by another route.
  if exists (select 1 from public.live_auction_item_skus l where l.source_batch_id = p_batch_id) then
    raise exception 'BATCH_HAS_CONSUMPTION' using errcode='P0001';
  end if;

  -- Never leave a SKU with zero cost layers (the sale path needs at least one).
  select count(*) into v_count from public.sku_batches b where b.sku_id = v_sku and b.org_id = v_org;
  if v_count <= 1 then raise exception 'CANNOT_DELETE_LAST_BATCH' using errcode='P0001'; end if;

  delete from public.sku_batches where id = p_batch_id and org_id = v_org;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand - v_rem
     where s.id = v_sku and s.org_id = v_org
     returning s.qty_on_hand into v_qoh;

  deleted_batch_id := p_batch_id; deleted_qty := v_rem; new_qty_on_hand := v_qoh;
  return next;
end;
$function$;

-- ══ 5. lensed_void_batch — the same protection on the ViewTrack removal path ═══════════
-- Baseline: production. void_batch can physically remove a layer, so it needs the identical
-- attribution check; its own untouched proof is defeatable in exactly the same way.
CREATE OR REPLACE FUNCTION public.lensed_void_batch(p_org_id uuid, p_batch_id uuid)
 RETURNS TABLE(batch_id uuid, sku_id uuid, qty_on_hand integer, voided_qty integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sku uuid;
  v_src text;
  v_rem int;
  v_added int;
  v_qoh int;
begin
  if p_org_id is null then raise exception 'MISSING_ORG' using errcode='22023'; end if;

  -- Locate the layer (org-scoped). Only integration-created layers are voidable
  -- through this path, so a stray id can't nuke a hand-entered cost layer.
  select b.sku_id, b.source into v_sku, v_src
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = p_org_id;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;
  if v_src is distinct from 'viewtrack' then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;

  -- Serialize against concurrent sales on this SKU, then decide on fresh state.
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));

  select b.qty_remaining, b.qty_added into v_rem, v_added
    from public.sku_batches b
    where b.id = p_batch_id and b.org_id = p_org_id;

  -- Untouched iff nothing has been drawn: qty_remaining still equals qty_added.
  if v_added is null or v_rem <> v_added then
    raise exception 'ALREADY_DRAWN' using errcode='P0001';
  end if;

  -- 154: same friendly pre-check as lensed_delete_batch. void_batch uses the identical
  -- defeatable qty_remaining = qty_added proof, and lensed_edit_batch has no source filter,
  -- so a 'viewtrack' layer can be edited back to looking untouched and then voided. Ask the
  -- attribution question directly rather than letting the FK answer it as a raw 23503.
  if exists (select 1 from public.live_auction_item_skus l where l.source_batch_id = p_batch_id) then
    raise exception 'BATCH_HAS_CONSUMPTION' using errcode='P0001';
  end if;

  -- Remove the layer (this also removes its source/external_ref idempotency row).
  delete from public.sku_batches where id = p_batch_id and org_id = p_org_id;

  -- Restore stock in lockstep (same transaction).
  update public.inventory_skus s set qty_on_hand = s.qty_on_hand - v_added
    where s.id = v_sku and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := p_batch_id; sku_id := v_sku; qty_on_hand := v_qoh; voided_qty := v_added;
  return next;
end;
$function$;

-- ══ 6. THE SECOND COST PATH, CLOSED AT THE TABLE ══════════════════════════════════════
--
-- Refusing the cost change inside lensed_edit_batch is necessary but NOT sufficient. The
-- sku_batches RLS policies created by migration 035b are the generic org-scoped four:
--
--     create policy sku_batches_org_upd on public.sku_batches
--       for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
--
-- No role clause, no column restriction. So any signed-in org member — including a seller
-- account, whose organization_members row is role 'member' and which is_org_member() treats
-- identically — can send
--
--     PATCH /rest/v1/sku_batches?id=eq.<uuid>   {"unit_cost_cents": 999}
--
-- straight through PostgREST and move a layer's cost WITHOUT the advisory lock, without
-- repricing the sales that layer supplied, and without an audit row. That is precisely the
-- "two competing ways to change cost" this migration exists to eliminate, and no amount of
-- care inside the RPCs can reach it.
--
-- WHY A TRIGGER AND NOT A COLUMN-LEVEL REVOKE. `revoke update (unit_cost_cents) on
-- public.sku_batches from authenticated` would also break the legitimate path: every one of
-- these RPCs is SECURITY INVOKER, so they execute AS `authenticated` and would lose the same
-- privilege they need. A trigger discriminates on HOW the write arrived rather than on who
-- made it.
--
-- SCOPE — deliberately narrow. It fires only when ALL of:
--     • the cost actually changes (is distinct from), and
--     • the layer is attributable (qty_added_authoritative), and
--     • the transaction-local marker set by lensed_finalize_batch_cost is absent.
-- So: legacy layers are untouched (Part 7 — they have no attribution to reprice, and their
-- direct-edit behaviour is preserved); quantity-only writes pass; the FIFO draw passes;
-- settle passes; an INSERT of a brand-new layer is not an UPDATE and passes. The marker is
-- transaction-local (set_config's third argument is true), so it cannot leak between
-- statements in other transactions, and PostgREST gives a client no way to set it.
create or replace function public.guard_sku_batch_cost_write()
returns trigger language plpgsql as $$
begin
  if new.unit_cost_cents is distinct from old.unit_cost_cents
     and coalesce(old.qty_added_authoritative, false)
     and coalesce(current_setting('lensed.batch_cost_write', true), '') <> '1' then
    raise exception 'COST_EDIT_REQUIRES_FINALIZE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.guard_sku_batch_cost_write() is
  'BEFORE UPDATE guard on sku_batches: an attributable layer''s unit_cost_cents may only '
  'change through lensed_finalize_batch_cost, which sets the transaction-local marker '
  'lensed.batch_cost_write. Closes the direct-PostgREST bypass left open by the generic '
  'org-scoped RLS update policy from migration 035b.';

drop trigger if exists sku_batches_guard_cost_write on public.sku_batches;
create trigger sku_batches_guard_cost_write
  before update on public.sku_batches
  for each row execute function public.guard_sku_batch_cost_write();

-- ══ Grants — restated per CONVENTIONS.md ══════════════════════════════════════════════
-- lensed_finalize_batch_cost is called from a USER session (the inventory Enter-cost
-- action), so it needs `authenticated`. The others keep the exact posture production
-- already has; CREATE OR REPLACE preserves an existing ACL, so those lines are no-ops.
-- lensed_void_batch stays service-role-only and is already registered in SERVICE_ROLE_ONLY
-- in scripts/check-rpc-grants.mjs.
--
-- ⚠ THE REVOKE BELOW IS NOT OPTIONAL, AND IT MUST COME BEFORE THE GRANT.
-- A newly CREATEd function has proacl = NULL, and a NULL ACL means PUBLIC holds EXECUTE
-- implicitly — so `anon` can call it the moment it exists. Granting to `authenticated`
-- does NOT take that away (verified: after `grant ... to authenticated`,
-- has_function_privilege('anon', …, 'EXECUTE') is still true; only an explicit revoke
-- clears it, and the revoke leaves `authenticated` intact). Without this line, shipping a
-- brand-new write RPC would silently re-open the exact anon/PUBLIC write exposure
-- 202608161754_revoke_anon_write_rpcs.sql exists to close. It is not exploitable — the
-- function raises NOT_AUTHENTICATED when auth.uid() is null — but "not exploitable today"
-- is not the posture this repo holds for write RPCs.
-- Revoking PUBLIC also strips `service_role`, which on a brand-new function holds EXECUTE
-- only through PUBLIC. Every one of this function's ten siblings carries an explicit
-- service_role=X in production, so it is re-granted here to match that posture exactly —
-- not a widening (service_role is the server-side master key and already bypasses RLS),
-- just consistency, so an admin-client caller never hits a surprise permission error.
revoke execute on function public.lensed_finalize_batch_cost(uuid, uuid, int) from public, anon;
grant  execute on function public.lensed_finalize_batch_cost(uuid, uuid, int) to authenticated;
grant  execute on function public.lensed_finalize_batch_cost(uuid, uuid, int) to service_role;
grant execute on function public.lensed_edit_batch(uuid, uuid, int, int, boolean) to authenticated;
grant execute on function public.lensed_delete_batch(uuid, uuid) to authenticated;
revoke execute on function public.lensed_void_batch(uuid, uuid) from public, anon, authenticated;
