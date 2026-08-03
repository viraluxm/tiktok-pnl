-- Behavioral assertions for migration 072 (FIFO cost-layer edit + delete).
-- Runs after bootstrap.sql + 072_fifo_batch_edit_delete.sql inside a throwaway
-- Postgres (see run.sh). Any failed assertion RAISEs and aborts (ON_ERROR_STOP=1).
-- One big transaction-scoped block orchestrates users via set_config('test.user_id').

do $$
declare
  A     uuid := '11111111-1111-1111-1111-111111111111';   -- user A / org 1
  ORG1  uuid := '22222222-2222-2222-2222-222222222222';
  B     uuid := '33333333-3333-3333-3333-333333333333';   -- user B / org 2
  SKU_X uuid; SKU_Y uuid; SKU_Z uuid; SKU_W uuid;
  L0 uuid; L1 uuid; L2 uuid; L3 uuid; LZ uuid; W1 uuid; W2 uuid; SALE uuid;
  v int; v2 int; v_cost int; v_qoh int; v_cnt int; v_msg text;
begin
  perform set_config('test.user_id', A::text, true);

  -- ── setup: SKU X in org1 with two RPC-added layers + one LEGACY layer ────────
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 1, 'X', 'X', 500, 0) returning id into SKU_X;
  select public.lensed_add_batch(SKU_X, 10, 500) into L1;   -- seq1, qty_added 10
  select public.lensed_add_batch(SKU_X, 5, 700)  into L2;   -- seq2, qty_added 5
  -- legacy layer: original qty NEVER recorded (qty_added NULL), +3 units on hand
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
    values (A, ORG1, SKU_X, 3, null, 400, 0) returning id into L0;
  update public.inventory_skus set qty_on_hand = qty_on_hand + 3 where id = SKU_X;   -- keep 034 invariant → 18
  -- a recorded past SALE snapshot at cost 500 (history that must never change)
  insert into public.live_auction_item_skus (user_id, inventory_sku_id, qty, unit_cost_cents_snapshot)
    values (A, SKU_X, 2, 500) returning id into SALE;

  -- add populated qty_added on the manual layers
  select qty_added into v from public.sku_batches where id = L1;
  if v <> 10 then raise exception 'ADD: L1 qty_added expected 10 got %', v; end if;
  select qty_added into v from public.sku_batches where id = L2;
  if v <>  5 then raise exception 'ADD: L2 qty_added expected 5 got %', v; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_X;
  if v_qoh <> 18 then raise exception 'SETUP: qty_on_hand expected 18 got %', v_qoh; end if;
  raise notice '✓ add populates qty_added; setup qty_on_hand=18';

  -- ── A. increasing remaining raises qty_on_hand by the same delta ─────────────
  perform public.lensed_edit_batch(SKU_X, L2, 9, 700);   -- 5 → 9 (+4)
  select qty_remaining into v from public.sku_batches where id = L2;
  select qty_on_hand   into v_qoh from public.inventory_skus where id = SKU_X;
  if v <> 9    then raise exception 'A: L2 remaining expected 9 got %', v; end if;
  if v_qoh<>22 then raise exception 'A: qty_on_hand expected 22 got %', v_qoh; end if;
  raise notice '✓ A increase remaining +4 → qty_on_hand 18→22';

  -- ── B. decreasing remaining lowers qty_on_hand by the same delta ─────────────
  perform public.lensed_edit_batch(SKU_X, L2, 6, 700);   -- 9 → 6 (-3)
  select qty_remaining into v from public.sku_batches where id = L2;
  select qty_on_hand   into v_qoh from public.inventory_skus where id = SKU_X;
  if v <> 6    then raise exception 'B: L2 remaining expected 6 got %', v; end if;
  if v_qoh<>19 then raise exception 'B: qty_on_hand expected 19 got %', v_qoh; end if;
  raise notice '✓ B decrease remaining -3 → qty_on_hand 22→19';

  -- ── C. cost-only edit leaves qty_on_hand unchanged ───────────────────────────
  perform public.lensed_edit_batch(SKU_X, L2, 6, 800);   -- same qty, cost 700→800
  select unit_cost_cents into v_cost from public.sku_batches where id = L2;
  select qty_on_hand     into v_qoh  from public.inventory_skus where id = SKU_X;
  if v_cost<>800 then raise exception 'C: cost expected 800 got %', v_cost; end if;
  if v_qoh <>19  then raise exception 'C: qty_on_hand must stay 19 got %', v_qoh; end if;
  -- cost may be set to null (unknown), still no qty change
  perform public.lensed_edit_batch(SKU_X, L2, 6, null);
  select unit_cost_cents into v_cost from public.sku_batches where id = L2;
  select qty_on_hand     into v_qoh  from public.inventory_skus where id = SKU_X;
  if v_cost is not null then raise exception 'C: cost expected NULL got %', v_cost; end if;
  if v_qoh <> 19        then raise exception 'C: qty_on_hand must stay 19 got %', v_qoh; end if;
  perform public.lensed_edit_batch(SKU_X, L2, 6, 800);   -- restore
  raise notice '✓ C cost-only edit (incl → null) leaves qty_on_hand at 19';

  -- ── D. historical unit_cost_cents_snapshot is never touched ──────────────────
  select unit_cost_cents_snapshot into v_cost from public.live_auction_item_skus where id = SALE;
  if v_cost <> 500 then raise exception 'D: sale snapshot must stay 500 got %', v_cost; end if;
  raise notice '✓ D recorded sale snapshot unchanged (500) after cost edits';

  -- ── E. negative remaining qty is rejected ────────────────────────────────────
  begin
    perform public.lensed_edit_batch(SKU_X, L2, -1, 800);
    raise exception 'E: negative qty was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('INVALID_QTY' in v_msg) = 0 then raise exception 'E: expected INVALID_QTY got %', v_msg; end if;
  end;
  raise notice '✓ E negative remaining qty rejected (INVALID_QTY)';

  -- ── F. negative cost is rejected ─────────────────────────────────────────────
  begin
    perform public.lensed_edit_batch(SKU_X, L2, 6, -5);
    raise exception 'F: negative cost was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('INVALID_COST' in v_msg) = 0 then raise exception 'F: expected INVALID_COST got %', v_msg; end if;
  end;
  raise notice '✓ F negative cost rejected (INVALID_COST)';

  -- ── G. cross-organization edit AND delete are rejected ───────────────────────
  perform set_config('test.user_id', B::text, true);
  begin
    perform public.lensed_edit_batch(SKU_X, L2, 1, 100);
    raise exception 'G: cross-org edit was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_FOUND' in v_msg) = 0 then raise exception 'G-edit: expected BATCH_NOT_FOUND got %', v_msg; end if;
  end;
  begin
    perform public.lensed_delete_batch(SKU_X, L2);
    raise exception 'G: cross-org delete was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_FOUND' in v_msg) = 0 then raise exception 'G-del: expected BATCH_NOT_FOUND got %', v_msg; end if;
  end;
  perform set_config('test.user_id', A::text, true);
  -- cross-org attempts must have changed nothing
  select qty_remaining into v from public.sku_batches where id = L2;
  select qty_on_hand   into v_qoh from public.inventory_skus where id = SKU_X;
  if v <> 6 or v_qoh <> 19 then raise exception 'G: cross-org attempt mutated state (rem=% qoh=%)', v, v_qoh; end if;
  raise notice '✓ G cross-org edit + delete rejected (BATCH_NOT_FOUND), no state change';

  -- ── H. wrong SKU/batch pairing is rejected ───────────────────────────────────
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 2, 'Y', 'Y', 100, 0) returning id into SKU_Y;
  begin
    perform public.lensed_edit_batch(SKU_Y, L2, 1, 100);   -- L2 belongs to X, not Y
    raise exception 'H: wrong sku/batch pairing was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_FOUND' in v_msg) = 0 then raise exception 'H: expected BATCH_NOT_FOUND got %', v_msg; end if;
  end;
  raise notice '✓ H wrong SKU/batch pairing rejected (BATCH_NOT_FOUND)';

  -- ── I. an untouched new layer can be deleted; qty_on_hand drops by its qty ────
  select public.lensed_add_batch(SKU_X, 4, 900) into L3;   -- untouched: qty_remaining=qty_added=4
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_X;
  if v_qoh <> 23 then raise exception 'I: pre-delete qty_on_hand expected 23 got %', v_qoh; end if;
  perform public.lensed_delete_batch(SKU_X, L3);
  select count(*) into v_cnt from public.sku_batches where id = L3;
  if v_cnt <> 0 then raise exception 'I: L3 should have been deleted'; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_X;
  if v_qoh <> 19 then raise exception 'I: qty_on_hand should drop by 4 to 19 got %', v_qoh; end if;
  raise notice '✓ I untouched layer deleted; qty_on_hand 23→19 (−4)';

  -- ── J. a partially consumed layer cannot be deleted ──────────────────────────
  update public.sku_batches   set qty_remaining = qty_remaining - 3 where id = L1;   -- 10 → 7 (drawn by a sale)
  update public.inventory_skus set qty_on_hand   = qty_on_hand   - 3 where id = SKU_X; -- keep invariant → 16
  begin
    perform public.lensed_delete_batch(SKU_X, L1);
    raise exception 'J: partially-consumed delete was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_DELETABLE' in v_msg) = 0 then raise exception 'J: expected BATCH_NOT_DELETABLE got %', v_msg; end if;
  end;
  raise notice '✓ J partially-consumed layer refused (BATCH_NOT_DELETABLE)';

  -- ── K. a legacy layer (qty_added IS NULL) cannot be physically deleted ───────
  begin
    perform public.lensed_delete_batch(SKU_X, L0);
    raise exception 'K: legacy NULL delete was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_DELETABLE' in v_msg) = 0 then raise exception 'K: expected BATCH_NOT_DELETABLE got %', v_msg; end if;
  end;
  raise notice '✓ K legacy qty_added-NULL layer refused (BATCH_NOT_DELETABLE)';

  -- ── L. the SKU''s last remaining layer cannot be deleted ─────────────────────
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 3, 'Z', 'Z', 100, 0) returning id into SKU_Z;
  select public.lensed_add_batch(SKU_Z, 2, 100) into LZ;   -- the ONLY layer (untouched)
  begin
    perform public.lensed_delete_batch(SKU_Z, LZ);
    raise exception 'L: last-batch delete was NOT rejected';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('CANNOT_DELETE_LAST_BATCH' in v_msg) = 0 then raise exception 'L: expected CANNOT_DELETE_LAST_BATCH got %', v_msg; end if;
  end;
  raise notice '✓ L last remaining layer refused (CANNOT_DELETE_LAST_BATCH)';

  -- ── M. correcting an UNTOUCHED layer re-bases qty_added (stays untouched) ────
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 4, 'W', 'W', 1000, 0) returning id into SKU_W;
  select public.lensed_add_batch(SKU_W, 100, 1000) into W1;   -- untouched: qty_added = qty_remaining = 100
  select public.lensed_add_batch(SKU_W, 5, 1000)   into W2;   -- 2nd layer so W1 is not the last
  perform public.lensed_edit_batch(SKU_W, W1, 90, 1000);      -- correct 100 → 90
  select qty_remaining, qty_added into v, v2 from public.sku_batches where id = W1;
  if v <> 90 or v2 <> 90 then raise exception 'M: untouched correction expected remaining=90 qty_added=90 got r=% a=%', v, v2; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_W;   -- 105 − 10 = 95
  if v_qoh <> 95 then raise exception 'M: SKU_W qty_on_hand expected 95 got %', v_qoh; end if;
  raise notice '✓ M untouched correction 100→90 re-bases qty_added to 90 (qty_on_hand 105→95)';

  -- ── N. the corrected-but-still-untouched layer can still be deleted ──────────
  perform public.lensed_delete_batch(SKU_W, W1);
  select count(*) into v_cnt from public.sku_batches where id = W1;
  if v_cnt <> 0 then raise exception 'N: corrected untouched W1 should be deletable'; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_W;   -- 95 − 90 = 5
  if v_qoh <> 5 then raise exception 'N: SKU_W qty_on_hand expected 5 after delete got %', v_qoh; end if;
  raise notice '✓ N corrected-untouched layer still deletable (qty_on_hand 95→5)';

  -- ── O. editing a PARTIALLY CONSUMED layer never rewrites qty_added ───────────
  -- L1 was drawn by a sale in test J: qty_remaining 7, qty_added 10.
  perform public.lensed_edit_batch(SKU_X, L1, 6, 500);   -- 7 → 6
  select qty_remaining, qty_added into v, v2 from public.sku_batches where id = L1;
  if v  <> 6  then raise exception 'O: L1 remaining expected 6 got %', v; end if;
  if v2 <> 10 then raise exception 'O: L1 qty_added must stay 10 (consumed) got %', v2; end if;
  raise notice '✓ O consumed-layer edit leaves qty_added=10 (remaining 7→6, still non-deletable)';

  -- ── P. editing a LEGACY (qty_added NULL) layer leaves qty_added NULL ─────────
  perform public.lensed_edit_batch(SKU_X, L0, 2, 400);   -- 3 → 2
  select qty_remaining, qty_added into v, v2 from public.sku_batches where id = L0;
  if v <> 2 then raise exception 'P: L0 remaining expected 2 got %', v; end if;
  if v2 is not null then raise exception 'P: L0 qty_added must stay NULL got %', v2; end if;
  raise notice '✓ P legacy-layer edit leaves qty_added NULL (remaining 3→2)';

  -- ── Q. an OMITTED cost (p_set_cost=false) leaves the existing cost untouched ─
  -- L2 cost is 800 here; a qty-only edit with p_set_cost=false must not change it.
  perform public.lensed_edit_batch(SKU_X, L2, 6, 999, false);
  select unit_cost_cents into v_cost from public.sku_batches where id = L2;
  if v_cost <> 800 then raise exception 'Q: cost must remain 800 (p_set_cost false) got %', v_cost; end if;
  raise notice '✓ Q qty-only edit (p_set_cost=false) leaves cost at 800';

  -- ── invariant: Σ qty_remaining == qty_on_hand for SKU X ──────────────────────
  select coalesce(sum(qty_remaining),0) into v from public.sku_batches where sku_id = SKU_X;   -- 2+6+6 = 14
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKU_X;
  if v <> v_qoh then raise exception 'INV: Σqty_remaining=% <> qty_on_hand=% for SKU_X', v, v_qoh; end if;
  raise notice '✓ invariant holds: Σqty_remaining = qty_on_hand = %', v_qoh;

  raise notice '✅ ALL BATCH EDIT/DELETE BEHAVIORAL ASSERTIONS PASSED';
end $$;

-- ── structural: edit/delete take the SAME per-SKU advisory lock as live sales ──
-- lensed_log_auction serializes each SKU with pg_advisory_xact_lock(hashtextextended(
-- 'sku:'||sku_id,0)); assert the new RPCs (and add) use the identical construct.
do $$
declare
  s text;
  def text;
begin
  foreach s in array array[
    'public.lensed_edit_batch(uuid,uuid,int,int,boolean)',
    'public.lensed_delete_batch(uuid,uuid)',
    'public.lensed_add_batch(uuid,int,int)'
  ] loop
    def := pg_get_functiondef(s::regprocedure);
    if position('pg_advisory_xact_lock' in def) = 0
       or position('hashtextextended' in def) = 0
       or position('sku:' in def) = 0 then
      raise exception 'LOCK: % does not take the sku:-keyed advisory lock', s;
    end if;
  end loop;
  raise notice '✓ edit/delete/add all take pg_advisory_xact_lock(hashtextextended(''sku:''…)) — same key as live sales';
end $$;
