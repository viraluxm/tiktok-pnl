-- 153: FIFO foundation, part 2 — populate the 152 columns. REQUIRES 152.
--
-- Eight CREATE OR REPLACE statements. Their bodies are migration-105-style: the LIVE
-- pg_get_functiondef() output pulled from production on 2026-09-11, with a small number of
-- surgical edits and NOTHING else changed. Each edit was applied by exact string match and
-- asserted to hit exactly one occurrence, so the diff against production is only what is
-- listed below. Signatures, RETURNS TABLE shapes, LANGUAGE, SECURITY, SET clauses, advisory
-- locking, org/store scoping, idempotency, the subtransaction + unique_violation replay
-- handler, Option-X FIFO selection and the p_allow_negative oversell path are all untouched.
--
-- ── PROVENANCE OF EACH BASELINE (checked by normalized diff against live prosrc) ────────
-- Every one of the eight bodies below was verified byte-identical to production before being
-- edited, so nothing unexplained is overwritten. The WINNING pre-feature definition of each —
-- which is also its ROLLBACK source — is:
--
--   lensed_add_batch        083_fifo_batch_edit_delete
--   lensed_add_batch_admin  046_viewtrack_void_batch      ← NOT 045: 046 supersedes it
--   lensed_edit_batch       083_fifo_batch_edit_delete
--   lensed_settle_batch     035b_shared_inventory_orgs
--   lensed_log_auction      105_bind_records_short_at_bind
--   lensed_log_auction_as   105_bind_records_short_at_bind
--   lensed_unbind           083_lensed_unbind_multisku
--   lensed_unbind_as        134_squish_multibind_audit    ← NOT 083_lensed_unbind_multisku,
--                                                            which does not define it; reverting
--                                                            from anywhere else re-opens the
--                                                            uq_sku_batches_source_ref collision
--                                                            that 134 fixed.
--
-- A note on lensed_add_batch_admin specifically: migration 045 does NOT stamp qty_added, which
-- once looked like production drift. It is not. 046 redefines the function WITH qty_added and
-- is byte-identical to live. 045 is simply superseded.
--
-- ── THE COMPLETE SET OF BEHAVIOUR CHANGES ─────────────────────────────────────────────
--
-- 1. EVERY FIFO DRAW NOW RECORDS ITS SOURCE LAYER.
--    lensed_log_auction and lensed_log_auction_as select exactly one sku_batches row per
--    sale line and decrement its qty_remaining. Both draw sites now also write that row's
--    id to live_auction_item_skus.source_batch_id:
--      • the insert path (a new sold order), via a new 'batch_id' key on the v_costed jsonb;
--      • the not_sold -> sold flip path, in the same UPDATE that writes the cost snapshot.
--    The value written is the id of the SAME row whose qty_remaining was decremented, in the
--    same statement sequence under the same per-SKU advisory lock, so the attribution cannot
--    disagree with the quantity movement — including on the oversell path, where the drawn
--    layer is the newest one going negative.
--    v_batch_id is reset to NULL at the top of every line iteration. This matters: v_batch is
--    a record that outlives a loop iteration, so a not_sold line — which draws nothing — would
--    otherwise inherit the previous line's batch id and fabricate an allocation that never
--    happened. not_sold lines keep source_batch_id NULL, which is the truth.
--
-- 2. EVERY NEW BATCH DECLARES ITS COST STATE, AND ITS qty_added IS AUTHORITATIVE.
--    lensed_add_batch, lensed_add_batch_admin and the unbind restock layer all now write
--    cost_status ('pending' when the cost is blank, 'final' when a number was given —
--    INCLUDING 0) and qty_added_authoritative = true. From here on, (0,'final') is genuinely
--    free inventory and (NULL,'pending') is inventory awaiting a price. They are no longer
--    the same row.
--
-- 3. AN AUTHORITATIVE qty_added IS NEVER RE-BASED BY A STOCK CORRECTION.
--    lensed_edit_batch previously rewrote qty_added to the new quantity whenever a layer
--    looked untouched. On a post-152 batch that erases the receipt: receive 500, correct
--    current stock to 450, and nothing remembers that 500 arrived. The re-base is now gated
--    on NOT qty_added_authoritative, so legacy layers behave EXACTLY as before and new layers
--    keep their receipt. (coalesce guards the concurrent-delete race where the post-lock
--    re-select finds no row.)
--
-- 4. SETTING A COST MOVES ITS STATE WITH IT.
--    lensed_edit_batch with p_set_cost = true now also sets cost_status: blank -> 'pending',
--    a number -> 'final'. This keeps sku_batches_cost_status_chk true by construction rather
--    than by convention, and it lets a human resolve a 'legacy' row's cost uncertainty simply
--    by entering the cost. A qty-only edit (p_set_cost false) touches neither cost nor state.
--
-- 5. SETTLING AN OVERSOLD LAYER GROWS ITS RECEIPT TOTAL.
--    lensed_settle_batch brings a negative layer up to 0 by ADDING the deficit — real units
--    that genuinely arrived late. If qty_added did not grow with them, the derived Consumed
--    (qty_added - qty_remaining) would report ZERO for units that really were consumed: a
--    quick-add seed layer starts at qty_added = 0, sells 5 (qty_remaining = -5, Consumed = 5
--    correctly), then settle takes it to 0 and Consumed silently becomes 0 - 0 = 0. Growing
--    qty_added by the same deficit keeps "Received 5 / Remaining 0 / Consumed 5" truthful.
--    Gated on qty_added_authoritative, so legacy layers are byte-for-byte unchanged. This is
--    included NOT as scope creep but because the derived figure 152 introduces would
--    otherwise regress on the very first oversell-then-settle.
--
-- ── WHAT THIS MIGRATION STILL DOES NOT DO ─────────────────────────────────────────────
--   • No repricing. unit_cost_cents_snapshot is written exactly when it was before, from
--     exactly the same value. Every historical COGS figure is byte-identical after this.
--   • No backfill of source_batch_id. Pre-152 lines stay NULL.
--   • No new RPC. The finalize-cost / historical-repricing RPC is a SEPARATE, REVIEWED stage.
--   • No change to FIFO selection. The whole-line "Option X" rule (oldest layer that covers
--     the entire line quantity; a line is never split) is preserved verbatim, including its
--     consequence that a bundle line can skip a partially-stocked older layer. Documented as
--     follow-up work, deliberately out of scope here.
--   • No change to lensed_delete_auction_item, which still restocks qty_on_hand without
--     restoring the drawn layer. The new FK does not make that path unsafe: it deletes sale
--     lines (children), never batches (parents).
--   • No change to the prod-only per-minute cost-mirror cron.
--
-- ── APPLY ORDER ───────────────────────────────────────────────────────────────────────
-- 152 first (schema, inert). This file second. 153 cannot be applied against a schema
-- without 152's columns — the INSERT column lists name them.
--
-- ── CLASS ─────────────────────────────────────────────────────────────────────────────
-- CLASS B per CLAUDE.md: CREATE OR REPLACE on functions the live capture path calls. Needs a
-- genuine write-silence window (no live show binding orders). CREATE OR REPLACE preserves
-- each function's existing ACL; the grants below are restated per CONVENTIONS.md as the
-- backstop for the Management-API path CI cannot see.


-- ── LOCK SAFETY (CLAUDE.md, "Required recipe, every time") ────────────────────────────
-- CLAUDE.md is explicit that a quiet window is NOT what makes this safe: "A foreign key takes
-- SHARE ROW EXCLUSIVE on the *referenced* table, and inventory_skus IS written mid-show …
-- lock_timeout is what makes that safe — not the absence of a show. Never skip it."
--
-- The danger is not how long these statements HOLD a lock (measured end-to-end at production
-- scale — 178,632 live_auction_item_skus rows, 25 MB — all three files apply in ~80 ms, index
-- build and validation scan included). The danger is WAITING for one: a pending ACCESS
-- EXCLUSIVE request queues ahead of every later request, including plain SELECTs, so a single
-- long-running reader turns an 80 ms migration into an unbounded stall of the capture path.
-- lock_timeout converts that stall into a clean abort.
--
-- SET LOCAL is scoped to the surrounding transaction, so this is correct in both supported
-- apply modes: `psql -1 -f <file>` (one transaction per file) and — preferred — all three
-- files inside a single BEGIN/COMMIT, where the first SET LOCAL covers the whole thing and
-- the later ones are harmless. Applied outside any transaction it degrades to a WARNING and
-- no timeout, which is why the runbook requires one of the two modes above.
--
-- If this aborts with 55P03 (lock_not_available), nothing was applied — the transaction rolls
-- back whole. Re-check for long-running transactions and retry; do NOT raise the timeout.
set local lock_timeout = '3s';

-- ══ 1. lensed_add_batch — a manual receipt: authoritative qty + explicit cost state ══
CREATE OR REPLACE FUNCTION public.lensed_add_batch(p_sku_id uuid, p_qty integer, p_unit_cost_cents integer)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_seq int; v_id uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = v_org) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));
  select coalesce(max(sequence),0)+1 into v_seq from public.sku_batches where sku_id = p_sku_id and org_id = v_org;
  -- 153: a manually added layer is a RECEIPT — qty_added is authoritative from creation.
  -- Cost state is explicit: blank cost is 'pending', any number (INCLUDING 0) is 'final'.
  insert into public.sku_batches
    (user_id, org_id, sku_id, qty_remaining, qty_added, qty_added_authoritative, unit_cost_cents, cost_status, sequence)
  values
    (v_user, v_org, p_sku_id, p_qty, p_qty, true, p_unit_cost_cents,
     case when p_unit_cost_cents is null then 'pending' else 'final' end, v_seq)
  returning id into v_id;
  update public.inventory_skus set qty_on_hand = qty_on_hand + p_qty where id = p_sku_id and org_id = v_org;
  return v_id;
end;
$function$;

-- ══ 2. lensed_add_batch_admin — ViewTrack receipt. BASELINE = PRODUCTION (see header) ══
CREATE OR REPLACE FUNCTION public.lensed_add_batch_admin(p_org_id uuid, p_sku_id uuid, p_qty integer, p_unit_cost_cents integer, p_external_ref text, p_system_user_id uuid)
 RETURNS TABLE(batch_id uuid, qty_on_hand integer, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_seq int;
  v_id uuid;
  v_existing uuid;
  v_qoh int;
begin
  if p_org_id is null then raise exception 'MISSING_ORG' using errcode='22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if p_unit_cost_cents is null or p_unit_cost_cents < 0 or p_unit_cost_cents > 100000 then
    raise exception 'INVALID_COST' using errcode='22023';
  end if;
  if p_external_ref is null or length(p_external_ref) = 0 then
    raise exception 'MISSING_REF' using errcode='22023';
  end if;

  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = p_org_id) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;

  v_user := coalesce(
    p_system_user_id,
    (select owner_user_id from public.organizations where id = p_org_id)
  );
  if v_user is null then raise exception 'NO_ATTRIBUTION_USER' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));

  select id into v_existing from public.sku_batches
    where org_id = p_org_id and source = 'viewtrack' and external_ref = p_external_ref;
  if found then
    select s.qty_on_hand into v_qoh from public.inventory_skus s where s.id = p_sku_id and s.org_id = p_org_id;
    batch_id := v_existing; qty_on_hand := v_qoh; replayed := true;
    return next; return;
  end if;

  select coalesce(max(sequence),0)+1 into v_seq
    from public.sku_batches where sku_id = p_sku_id and org_id = p_org_id;

  -- 153: ViewTrack pushes a real receipt, so qty_added is authoritative; cost state explicit.
  insert into public.sku_batches
    (user_id, org_id, sku_id, qty_remaining, qty_added, qty_added_authoritative, unit_cost_cents, cost_status, sequence, source, external_ref)
  values
    (v_user, p_org_id, p_sku_id, p_qty, p_qty, true, p_unit_cost_cents,
     case when p_unit_cost_cents is null then 'pending' else 'final' end, v_seq, 'viewtrack', p_external_ref)
  returning id into v_id;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + p_qty
    where s.id = p_sku_id and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := v_id; qty_on_hand := v_qoh; replayed := false;
  return next;
end;
$function$;

-- ══ 3. lensed_edit_batch — stop re-basing an authoritative receipt; move cost_status ══
CREATE OR REPLACE FUNCTION public.lensed_edit_batch(p_sku_id uuid, p_batch_id uuid, p_qty_remaining integer, p_unit_cost_cents integer, p_set_cost boolean DEFAULT true)
 RETURNS TABLE(batch_id uuid, new_qty_remaining integer, new_qty_added integer, new_unit_cost_cents integer, new_qty_on_hand integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_old int; v_added int; v_new_added int; v_was_untouched boolean;
  v_auth boolean;   -- 153: is qty_added the authoritative original receipt?
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
  select b.qty_remaining, b.qty_added, b.qty_added_authoritative into v_old, v_added, v_auth
    from public.sku_batches b where b.id = p_batch_id and b.org_id = v_org;

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

-- ══ 4. lensed_settle_batch — a settled deficit is a late receipt, so qty_added grows ══
CREATE OR REPLACE FUNCTION public.lensed_settle_batch(p_batch_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_org uuid := public.current_user_org();
  v_sku uuid; v_q int; v_deficit int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  select sku_id into v_sku from public.sku_batches where id = p_batch_id and org_id = v_org;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sku:'||v_sku::text, 0));
  select qty_remaining into v_q from public.sku_batches where id = p_batch_id and org_id = v_org;
  if v_q >= 0 then return 0; end if;
  v_deficit := -v_q;
  -- 153: settle brings an oversold layer up to 0 by ADDING v_deficit units that genuinely
  -- arrived. An authoritative receipt total must grow by the same amount, or the derived
  -- Consumed (qty_added - qty_remaining) would report 0 for units that really were consumed
  -- (seed layer qty_added=0 -> sells 5 -> qty_remaining=-5 -> settle -> 0-0=0, wrong).
  -- Legacy layers (qty_added_authoritative = false) are untouched, exactly as before.
  update public.sku_batches
     set qty_remaining = 0,
         qty_added = case when qty_added_authoritative then coalesce(qty_added, 0) + v_deficit
                          else qty_added end
   where id = p_batch_id and org_id = v_org;
  update public.inventory_skus set qty_on_hand = qty_on_hand + v_deficit where id = v_sku and org_id = v_org;
  return v_deficit;
end;
$function$;

-- ══ 5. lensed_log_auction — record the drawn layer at BOTH draw sites ══
CREATE OR REPLACE FUNCTION public.lensed_log_auction(p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean DEFAULT false, p_allow_negative boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, auction_number integer, status text, replayed boolean, expected_price_cents integer, total_cost_cents integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_existing record; v_session record; v_line jsonb;
  v_sku_id uuid; v_qty int; v_sku record; v_batch record; v_unit_cost int;
  v_total int := 0; v_missing boolean := false; v_expected int; v_seq int; v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record; v_costed jsonb := '[]'::jsonb; v_short boolean;
  v_batch_id uuid;   -- 153: the layer this line actually drew, persisted as provenance
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_result not in ('sold','not_sold') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  if p_skus is null or jsonb_array_length(p_skus)=0 then raise exception 'NO_SKUS' using errcode='22023'; end if;

  -- idempotency lock: serialize ops within this (private) session
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- ‚îÄ‚îÄ existing row (USER-owned; idempotent on the stable order key across ANY session) ‚îÄ‚îÄ
  -- EDIT 1: was `i.session_id = p_session_id and i.user_id = v_user and ...`. Dropping
  -- the session filter is the whole fix: a reload / 2nd instance / forked session that
  -- re-sends the same order_id now finds the canonical row instead of inserting a dup.
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
      from public.live_auction_items i
      where i.user_id = v_user and i.client_idempotency_key = p_idem_key
      limit 1;
    if found then
      if v_existing.status = 'not_sold' and p_result = 'sold' then
        update public.live_auction_items as t set status='sold', closed_at=now()
          where t.id = v_existing.id and t.user_id = v_user and t.status = 'not_sold';
        if not found then
          item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
          replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
          return next; return;
        end if;
        -- SHARED-stock serialization: lock the item's SKUs (sorted) before drawing
        perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
          from (select distinct inventory_sku_id as sid from public.live_auction_item_skus
                where auction_item_id = v_existing.id and user_id = v_user order by 1) z;
        for v_be in
          select s.inventory_sku_id, sum(s.qty)::int as qty from public.live_auction_item_skus s
            where s.auction_item_id = v_existing.id and s.user_id = v_user group by s.inventory_sku_id
        loop
          v_short := false;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            v_short := true;
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
            if not found then raise exception 'NO_BATCH:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001'; end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty where id = v_be.inventory_sku_id and org_id = v_org;
          -- 153: record WHICH layer supplied this line, alongside the cost it supplied.
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents, short_at_bind = v_short, source_batch_id = v_batch.id
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
        end loop;
        select coalesce(sum(s.unit_cost_cents_snapshot*s.qty),0)::int, bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing from public.live_auction_item_skus s where s.auction_item_id = v_existing.id and s.user_id = v_user;
        raise notice 'lensed_log_auction: TRANSITION not_sold->sold user=% order=% item=%', v_user, p_idem_key, v_existing.id;
        item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
        replayed:=false; expected_price_cents:=v_existing.expected_price_cents;
        total_cost_cents:=case when v_missing then null else v_total end;
        return next; return;
      end if;
      raise notice 'lensed_log_auction: REPLAY (duplicate skipped) user=% order=% status=%', v_user, p_idem_key, v_existing.status;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next; return;
    end if;
  end if;

  -- ‚îÄ‚îÄ new insert (USER-owned session) ‚îÄ‚îÄ
  -- EDIT 2: wrapped in a subtransaction. If a concurrent call for the SAME
  -- (user_id, order_id) in another session commits first, idx_live_auction_items_user_idem
  -- raises unique_violation here; the handler rolls back this block's FIFO draws and
  -- returns a clean replay of the canonical row ‚Äî never a duplicate row or second draw.
  begin
    select s.id, s.status, s.store_id into v_session from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
    if not found then raise exception 'SESSION_NOT_FOUND' using errcode='P0002'; end if;
    if v_session.status in ('ended','reconciled') and not p_manual then raise exception 'SESSION_ENDED' using errcode='P0001'; end if;

    -- SHARED-stock serialization: lock all SKUs this sale touches (sorted) up front
    perform pg_advisory_xact_lock(hashtextextended('sku:'||s, 0))
      from (select distinct (e->>'sku_id') as s from jsonb_array_elements(p_skus) e order by 1) z;

    for v_line in select * from jsonb_array_elements(p_skus) loop
      v_sku_id := (v_line->>'sku_id')::uuid;
      v_qty := greatest(1, coalesce((v_line->>'qty')::int, 1));
      select id, sku_number, title, unit_cost_cents into v_sku from public.inventory_skus where id = v_sku_id and org_id = v_org;
      if not found then raise exception 'SKU_NOT_FOUND' using errcode='22023'; end if;
      v_short := false;
      v_batch_id := null;   -- 153: reset PER LINE. v_batch is a loop-scoped record that
                            -- survives iterations, so a not_sold line (which draws nothing)
                            -- would otherwise inherit the previous line's batch id.
      if p_result = 'sold' then
        select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
          where b.sku_id = v_sku_id and b.org_id = v_org and b.qty_remaining >= v_qty order by b.sequence asc limit 1;
        if not found then
          if not p_allow_negative then raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode='P0001'; end if;
          v_short := true;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
          if not found then raise exception 'NO_BATCH:%', v_sku.sku_number using errcode='P0001'; end if;
        end if;
        update public.sku_batches set qty_remaining = qty_remaining - v_qty where id = v_batch.id;
        update public.inventory_skus set qty_on_hand = qty_on_hand - v_qty where id = v_sku_id and org_id = v_org;
        v_unit_cost := v_batch.unit_cost_cents;
        v_batch_id  := v_batch.id;   -- 153: same layer whose qty_remaining was just decremented
      else
        v_unit_cost := v_sku.unit_cost_cents;
      end if;
      if v_unit_cost is null then v_missing := true; else v_total := v_total + v_unit_cost * v_qty; end if;
      v_costed := v_costed || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost, 'sku_number', v_sku.sku_number, 'title', v_sku.title, 'short', v_short, 'batch_id', v_batch_id);
    end loop;

    v_expected := case when v_missing then null else v_total * 3 end;
    select coalesce(max(sequence),0)+1 into v_seq from public.live_auction_items where session_id = p_session_id and user_id = v_user;

    -- auction item + lines stay USER-owned; store_id stamped explicitly from the
    -- session ‚Äî PRESERVED from migration 041 so this fix does not revert store scoping.
    insert into public.live_auction_items
      (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
    values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
    returning id into v_item;
    insert into public.live_auction_item_skus
      (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot, short_at_bind, source_batch_id)
    select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title'), (l->>'short')::boolean, (l->>'batch_id')::uuid
    from jsonb_array_elements(v_costed) l;

    raise notice 'lensed_log_auction: NEW insert user=% order=% seq=%', v_user, p_idem_key, v_seq;
    item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
    expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
    return next;
  exception
    when unique_violation then
      -- Lost a concurrent race for this (user_id, order_id): another session inserted
      -- the canonical row first. This block's FIFO draws rolled back with the subtxn.
      select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
        from public.live_auction_items i
        where i.user_id = v_user and i.client_idempotency_key = p_idem_key
        limit 1;
      if not found then raise; end if;  -- not the order-dup case ‚Üí surface it
      raise notice 'lensed_log_auction: REPLAY (race, duplicate skipped) user=% order=%', v_user, p_idem_key;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next;
  end;
end;
$function$;

-- ══ 6. lensed_log_auction_as — identical edits to the service-role twin ══
CREATE OR REPLACE FUNCTION public.lensed_log_auction_as(p_owner_user_id uuid, p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean DEFAULT false, p_allow_negative boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, auction_number integer, status text, replayed boolean, expected_price_cents integer, total_cost_cents integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := p_owner_user_id;   -- CHANGED from: auth.uid()
  v_org uuid := (                    -- CHANGED from: public.current_user_org()
    select m.org_id from public.organization_members m
    where m.user_id = p_owner_user_id order by m.created_at limit 1);
  v_existing record; v_session record; v_line jsonb;
  v_sku_id uuid; v_qty int; v_sku record; v_batch record; v_unit_cost int;
  v_total int := 0; v_missing boolean := false; v_expected int; v_seq int; v_item uuid;
  v_is_bundle boolean := (jsonb_array_length(p_skus) > 1);
  v_be record; v_costed jsonb := '[]'::jsonb; v_short boolean;
  v_batch_id uuid;   -- 153: the layer this line actually drew, persisted as provenance
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_result not in ('sold','not_sold') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  if p_skus is null or jsonb_array_length(p_skus)=0 then raise exception 'NO_SKUS' using errcode='22023'; end if;

  -- idempotency lock: serialize ops within this (private) session
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  -- existing row (USER-owned; idempotent on the stable order key across ANY session)
  -- EDIT 1: was `i.session_id = p_session_id and i.user_id = v_user and ...`. Dropping
  -- the session filter is the whole fix: a reload / 2nd instance / forked session that
  -- re-sends the same order_id now finds the canonical row instead of inserting a dup.
  if p_idem_key is not null and length(p_idem_key) > 0 then
    select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
      from public.live_auction_items i
      where i.user_id = v_user and i.client_idempotency_key = p_idem_key
      limit 1;
    if found then
      if v_existing.status = 'not_sold' and p_result = 'sold' then
        update public.live_auction_items as t set status='sold', closed_at=now()
          where t.id = v_existing.id and t.user_id = v_user and t.status = 'not_sold';
        if not found then
          item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
          replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
          return next; return;
        end if;
        -- SHARED-stock serialization: lock the item's SKUs (sorted) before drawing
        perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
          from (select distinct inventory_sku_id as sid from public.live_auction_item_skus
                where auction_item_id = v_existing.id and user_id = v_user order by 1) z;
        for v_be in
          select s.inventory_sku_id, sum(s.qty)::int as qty from public.live_auction_item_skus s
            where s.auction_item_id = v_existing.id and s.user_id = v_user group by s.inventory_sku_id
        loop
          v_short := false;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org and b.qty_remaining >= v_be.qty
            order by b.sequence asc limit 1;
          if not found then
            v_short := true;
            if not p_allow_negative then
              raise exception 'OUT_OF_STOCK:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001';
            end if;
            select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
              where b.sku_id = v_be.inventory_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
            if not found then raise exception 'NO_BATCH:%', coalesce((select sku_number from public.inventory_skus where id=v_be.inventory_sku_id and org_id=v_org),0) using errcode='P0001'; end if;
          end if;
          update public.sku_batches set qty_remaining = qty_remaining - v_be.qty where id = v_batch.id;
          update public.inventory_skus set qty_on_hand = qty_on_hand - v_be.qty where id = v_be.inventory_sku_id and org_id = v_org;
          -- 153: record WHICH layer supplied this line, alongside the cost it supplied.
          update public.live_auction_item_skus set unit_cost_cents_snapshot = v_batch.unit_cost_cents, short_at_bind = v_short, source_batch_id = v_batch.id
            where auction_item_id = v_existing.id and inventory_sku_id = v_be.inventory_sku_id and user_id = v_user;
        end loop;
        select coalesce(sum(s.unit_cost_cents_snapshot*s.qty),0)::int, bool_or(s.unit_cost_cents_snapshot is null)
          into v_total, v_missing from public.live_auction_item_skus s where s.auction_item_id = v_existing.id and s.user_id = v_user;
        raise notice 'lensed_log_auction: TRANSITION not_sold->sold user=% order=% item=%', v_user, p_idem_key, v_existing.id;
        item_id:=v_existing.id; auction_number:=v_existing.sequence; status:='sold';
        replayed:=false; expected_price_cents:=v_existing.expected_price_cents;
        total_cost_cents:=case when v_missing then null else v_total end;
        return next; return;
      end if;
      raise notice 'lensed_log_auction: REPLAY (duplicate skipped) user=% order=% status=%', v_user, p_idem_key, v_existing.status;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next; return;
    end if;
  end if;

  -- new insert (USER-owned session)
  -- EDIT 2: wrapped in a subtransaction. If a concurrent call for the SAME
  -- (user_id, order_id) in another session commits first, idx_live_auction_items_user_idem
  -- raises unique_violation here; the handler rolls back this block's FIFO draws and
  -- returns a clean replay of the canonical row - never a duplicate row or second draw.
  begin
    select s.id, s.status, s.store_id into v_session from public.live_sessions s where s.id = p_session_id and s.user_id = v_user;
    if not found then raise exception 'SESSION_NOT_FOUND' using errcode='P0002'; end if;
    if v_session.status in ('ended','reconciled') and not p_manual then raise exception 'SESSION_ENDED' using errcode='P0001'; end if;

    -- SHARED-stock serialization: lock all SKUs this sale touches (sorted) up front
    perform pg_advisory_xact_lock(hashtextextended('sku:'||s, 0))
      from (select distinct (e->>'sku_id') as s from jsonb_array_elements(p_skus) e order by 1) z;

    for v_line in select * from jsonb_array_elements(p_skus) loop
      v_sku_id := (v_line->>'sku_id')::uuid;
      v_qty := greatest(1, coalesce((v_line->>'qty')::int, 1));
      select id, sku_number, title, unit_cost_cents into v_sku from public.inventory_skus where id = v_sku_id and org_id = v_org;
      if not found then raise exception 'SKU_NOT_FOUND' using errcode='22023'; end if;
      v_short := false;
      v_batch_id := null;   -- 153: reset PER LINE. v_batch is a loop-scoped record that
                            -- survives iterations, so a not_sold line (which draws nothing)
                            -- would otherwise inherit the previous line's batch id.
      if p_result = 'sold' then
        select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
          where b.sku_id = v_sku_id and b.org_id = v_org and b.qty_remaining >= v_qty order by b.sequence asc limit 1;
        if not found then
          if not p_allow_negative then raise exception 'OUT_OF_STOCK:%', v_sku.sku_number using errcode='P0001'; end if;
          v_short := true;
          select b.id, b.unit_cost_cents into v_batch from public.sku_batches b
            where b.sku_id = v_sku_id and b.org_id = v_org order by b.sequence desc limit 1;
          if not found then raise exception 'NO_BATCH:%', v_sku.sku_number using errcode='P0001'; end if;
        end if;
        update public.sku_batches set qty_remaining = qty_remaining - v_qty where id = v_batch.id;
        update public.inventory_skus set qty_on_hand = qty_on_hand - v_qty where id = v_sku_id and org_id = v_org;
        v_unit_cost := v_batch.unit_cost_cents;
        v_batch_id  := v_batch.id;   -- 153: same layer whose qty_remaining was just decremented
      else
        v_unit_cost := v_sku.unit_cost_cents;
      end if;
      if v_unit_cost is null then v_missing := true; else v_total := v_total + v_unit_cost * v_qty; end if;
      v_costed := v_costed || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'cost', v_unit_cost, 'sku_number', v_sku.sku_number, 'title', v_sku.title, 'short', v_short, 'batch_id', v_batch_id);
    end loop;

    v_expected := case when v_missing then null else v_total * 3 end;
    select coalesce(max(sequence),0)+1 into v_seq from public.live_auction_items where session_id = p_session_id and user_id = v_user;

    -- auction item + lines stay USER-owned; store_id stamped explicitly from the
    -- session - PRESERVED from migration 041 so this fix does not revert store scoping.
    insert into public.live_auction_items
      (user_id, store_id, session_id, sequence, status, is_bundle, expected_price_cents, client_idempotency_key, activated_at, closed_at)
    values (v_user, v_session.store_id, p_session_id, v_seq, p_result, v_is_bundle, v_expected, nullif(p_idem_key,''), now(), now())
    returning id into v_item;
    insert into public.live_auction_item_skus
      (user_id, store_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot, title_snapshot, short_at_bind, source_batch_id)
    select v_user, v_session.store_id, v_item, (l->>'sku_id')::uuid, (l->>'qty')::int, (l->>'cost')::int, (l->>'sku_number')::int, (l->>'title'), (l->>'short')::boolean, (l->>'batch_id')::uuid
    from jsonb_array_elements(v_costed) l;

    raise notice 'lensed_log_auction: NEW insert user=% order=% seq=%', v_user, p_idem_key, v_seq;
    item_id:=v_item; auction_number:=v_seq; status:=p_result; replayed:=false;
    expected_price_cents:=v_expected; total_cost_cents:=case when v_missing then null else v_total end;
    return next;
  exception
    when unique_violation then
      -- Lost a concurrent race for this (user_id, order_id): another session inserted
      -- the canonical row first. This block's FIFO draws rolled back with the subtxn.
      select i.id, i.sequence, i.status, i.expected_price_cents into v_existing
        from public.live_auction_items i
        where i.user_id = v_user and i.client_idempotency_key = p_idem_key
        limit 1;
      if not found then raise; end if;  -- not the order-dup case -> surface it
      raise notice 'lensed_log_auction: REPLAY (race, duplicate skipped) user=% order=%', v_user, p_idem_key;
      item_id:=v_existing.id; auction_number:=v_existing.sequence; status:=v_existing.status;
      replayed:=true; expected_price_cents:=v_existing.expected_price_cents; total_cost_cents:=null;
      return next;
  end;
end;
$function$;

-- ══ 7. lensed_unbind — the compensating restock layer is a post-cutover receipt ══
CREATE OR REPLACE FUNCTION public.lensed_unbind(p_order_id text)
 RETURNS TABLE(unbound boolean, item_id uuid, restocked_lines integer, restocked_units integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_item record; v_line record; v_seq int; v_n int := 0; v_u int := 0;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org  is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_order_id is null or length(p_order_id) = 0 then raise exception 'NO_ORDER' using errcode='22023'; end if;

  -- serialize ops on this order key (idempotency + concurrency)
  perform pg_advisory_xact_lock(hashtextextended('unbind:'||p_order_id, 0));

  select i.id into v_item
    from public.live_auction_items i
    where i.user_id = v_user and i.client_idempotency_key = p_order_id
    limit 1;
  if not found then
    -- already unbound / never bound → idempotent no-op, no restock
    unbound := false; item_id := null; restocked_lines := 0; restocked_units := 0; return next; return;
  end if;

  -- lock this item's SKUs (sorted) before touching shared stock — same discipline as the bind
  perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
    from (select distinct inventory_sku_id sid from public.live_auction_item_skus
          where auction_item_id = v_item.id and user_id = v_user order by 1) z;

  for v_line in
    select inventory_sku_id, sum(qty)::int as qty, max(unit_cost_cents_snapshot) as cost
      from public.live_auction_item_skus
      where auction_item_id = v_item.id and user_id = v_user
      group by inventory_sku_id
  loop
    -- restore the on-hand count (always, even if the original cost is unknown)
    update public.inventory_skus set qty_on_hand = qty_on_hand + v_line.qty
      where id = v_line.inventory_sku_id and org_id = v_org;
    -- add a fresh FIFO layer at the snapshot cost (tail of the sequence) when the cost is known.
    -- external_ref is per (order, sku) so multi-SKU orders don't collide on uq_sku_batches_source_ref.
    if v_line.cost is not null then
      select coalesce(max(sequence), 0) + 1 into v_seq
        from public.sku_batches where sku_id = v_line.inventory_sku_id and org_id = v_org;
      -- 153: the compensating layer is created here and now, and this branch only runs when
      -- v_line.cost IS NOT NULL, so both new facts are provable: qty_added is its true
      -- starting quantity, and the cost is known ⇒ 'final'.
      insert into public.sku_batches
        (user_id, org_id, sku_id, qty_remaining, qty_added, qty_added_authoritative, unit_cost_cents, cost_status, sequence, source, external_ref)
      values
        (v_user, v_org, v_line.inventory_sku_id, v_line.qty, v_line.qty, true, v_line.cost, 'final', v_seq, 'unbind_restock', p_order_id || ':' || v_line.inventory_sku_id::text);
    end if;
    v_n := v_n + 1; v_u := v_u + v_line.qty;
  end loop;

  delete from public.live_auction_item_skus where auction_item_id = v_item.id and user_id = v_user;
  delete from public.live_auction_items     where id = v_item.id and user_id = v_user;

  raise notice 'lensed_unbind: user=% order=% item=% lines=% units=%', v_user, p_order_id, v_item.id, v_n, v_u;
  unbound := true; item_id := v_item.id; restocked_lines := v_n; restocked_units := v_u; return next;
end;
$function$;

-- ══ 8. lensed_unbind_as — identical edit to the service-role twin ══
CREATE OR REPLACE FUNCTION public.lensed_unbind_as(p_owner_user_id uuid, p_order_id text)
 RETURNS TABLE(unbound boolean, item_id uuid, restocked_lines integer, restocked_units integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := p_owner_user_id;   -- CHANGED from: auth.uid()
  v_org  uuid := (                  -- CHANGED from: public.current_user_org()
    select m.org_id from public.organization_members m
    where m.user_id = p_owner_user_id order by m.created_at limit 1);
  v_item record; v_line record; v_seq int; v_n int := 0; v_u int := 0;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org  is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_order_id is null or length(p_order_id) = 0 then raise exception 'NO_ORDER' using errcode='22023'; end if;

  -- serialize ops on this order key (idempotency + concurrency)
  perform pg_advisory_xact_lock(hashtextextended('unbind:'||p_order_id, 0));

  select i.id into v_item
    from public.live_auction_items i
    where i.user_id = v_user and i.client_idempotency_key = p_order_id
    limit 1;
  if not found then
    -- already unbound / never bound → idempotent no-op, no restock
    unbound := false; item_id := null; restocked_lines := 0; restocked_units := 0; return next; return;
  end if;

  -- lock this item's SKUs (sorted) before touching shared stock — same discipline as the bind
  perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
    from (select distinct inventory_sku_id sid from public.live_auction_item_skus
          where auction_item_id = v_item.id and user_id = v_user order by 1) z;

  for v_line in
    select inventory_sku_id, sum(qty)::int as qty, max(unit_cost_cents_snapshot) as cost
      from public.live_auction_item_skus
      where auction_item_id = v_item.id and user_id = v_user
      group by inventory_sku_id
  loop
    -- restore the on-hand count (always, even if the original cost is unknown)
    update public.inventory_skus set qty_on_hand = qty_on_hand + v_line.qty
      where id = v_line.inventory_sku_id and org_id = v_org;
    -- add a fresh FIFO layer at the snapshot cost (tail of the sequence) when the cost is known.
    -- external_ref is per (order, sku) so multi-SKU orders don't collide on uq_sku_batches_source_ref.
    if v_line.cost is not null then
      select coalesce(max(sequence), 0) + 1 into v_seq
        from public.sku_batches where sku_id = v_line.inventory_sku_id and org_id = v_org;
      -- 153: the compensating layer is created here and now, and this branch only runs when
      -- v_line.cost IS NOT NULL, so both new facts are provable: qty_added is its true
      -- starting quantity, and the cost is known ⇒ 'final'.
      insert into public.sku_batches
        (user_id, org_id, sku_id, qty_remaining, qty_added, qty_added_authoritative, unit_cost_cents, cost_status, sequence, source, external_ref)
      values
        (v_user, v_org, v_line.inventory_sku_id, v_line.qty, v_line.qty, true, v_line.cost, 'final', v_seq, 'unbind_restock', p_order_id || ':' || v_line.inventory_sku_id::text || ':' || v_item.id::text);
    end if;
    v_n := v_n + 1; v_u := v_u + v_line.qty;
  end loop;

  delete from public.live_auction_item_skus where auction_item_id = v_item.id and user_id = v_user;
  delete from public.live_auction_items     where id = v_item.id and user_id = v_user;

  raise notice 'lensed_unbind_as: user=% order=% item=% lines=% units=%', v_user, p_order_id, v_item.id, v_n, v_u;
  unbound := true; item_id := v_item.id; restocked_lines := v_n; restocked_units := v_u; return next;
end;
$function$;

-- ══ Grants — restated verbatim per CONVENTIONS.md ═════════════════════════════════════
-- CREATE OR REPLACE preserves the existing ACL, so every line here is a no-op against the
-- live database. They are written anyway because CI only runs on PRs: if any of these is
-- ever applied straight through the Management API, this file is the record of the grant
-- that must go with it. The split below matches production's actual proacl exactly — user-
-- session RPCs keep `authenticated`; the three service-role-only twins stay revoked and are
-- already registered in SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs. Nothing here
-- widens any existing grant.

grant execute on function public.lensed_add_batch(uuid, int, int) to authenticated;
grant execute on function public.lensed_edit_batch(uuid, uuid, int, int, boolean) to authenticated;
grant execute on function public.lensed_log_auction(uuid, text, jsonb, text, boolean, boolean) to authenticated;
grant execute on function public.lensed_unbind(text) to authenticated;
grant execute on function public.lensed_settle_batch(uuid) to authenticated;

revoke execute on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from public, anon, authenticated;
revoke execute on function public.lensed_log_auction_as(uuid, uuid, text, jsonb, text, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.lensed_unbind_as(uuid, text) from public, anon, authenticated;
