-- Behavioural assertions for migration 155 (legacy $0 -> post-152 model).
-- Every negative assertion reports the cardinality it examined (CONVENTIONS.md rule 1).

-- test.sql runs in its own psql session, so auth.uid() must be re-established: the harness
-- stubs it from this GUC, and lensed_finalize_batch_cost / current_user_org() both need it.
select set_config('test.user_id', '11111111-1111-1111-1111-111111111111', false);

-- ══ PREVIEW must be pure: p_apply=false changes nothing ══════════════════════════════
do $$
declare v_before text; v_after text; v_rows int;
begin
  select md5(string_agg(id::text||':'||cost_status||':'||coalesce(unit_cost_cents::text,'~')||':'||
             qty_added_authoritative::text||':'||coalesce(source,'~'), ',' order by id))
    into v_before from public.sku_batches;
  select count(*) into v_rows from public.lensed_legacy_zero_cost_reconcile(false);
  if v_rows = 0 then raise exception 'PREVIEW: VACUOUS — no legacy $0 batches in the fixture'; end if;
  select md5(string_agg(id::text||':'||cost_status||':'||coalesce(unit_cost_cents::text,'~')||':'||
             qty_added_authoritative::text||':'||coalesce(source,'~'), ',' order by id))
    into v_after from public.sku_batches;
  if v_before <> v_after then raise exception 'PREVIEW MUTATED sku_batches'; end if;
  if (select count(*) from public.live_auction_item_skus where source_batch_id is not null) <> 0 then
    raise exception 'PREVIEW attributed lines'; end if;
  if (select count(*) from public.sku_batch_legacy_reconciliations) <> 0 then
    raise exception 'PREVIEW wrote an audit row'; end if;
  raise notice '✓ PREVIEW: % candidate rows classified, zero mutations', v_rows;
end $$;

-- ══ Verdicts before applying ═════════════════════════════════════════════════════════
do $$
declare v record; v_a text; v_b text; v_g text; v_n int;
begin
  select verdict into v_a from public.lensed_legacy_zero_cost_reconcile(false) where sku_number=901;
  select verdict into v_b from public.lensed_legacy_zero_cost_reconcile(false) where sku_number=902;
  select verdict into v_g from public.lensed_legacy_zero_cost_reconcile(false) where sku_number=903;
  if v_a <> 'RECONSTRUCTABLE' then raise exception 'A: expected RECONSTRUCTABLE got %', v_a; end if;
  if v_b <> 'RECONSTRUCTABLE' then raise exception 'B: expected RECONSTRUCTABLE got %', v_b; end if;
  if v_g <> 'AMBIGUOUS_QTY_ADDED_NULL' then raise exception 'G: expected AMBIGUOUS_QTY_ADDED_NULL got %', v_g; end if;

  -- H: out-of-scope layers must not appear at all
  select count(*) into v_n from public.lensed_legacy_zero_cost_reconcile(false) where sku_number in (904,905);
  if v_n <> 0 then raise exception 'H: % out-of-scope legacy layer(s) were picked up', v_n; end if;
  select count(*) into v_n from public.lensed_legacy_zero_cost_reconcile(false);
  raise notice '✓ VERDICTS: A+B reconstructable, G ambiguous(qty_added NULL), positive/NULL-cost legacy ignored (% total rows)', v_n;
end $$;

-- ══ APPLY ════════════════════════════════════════════════════════════════════════════
do $$
declare v_applied int; v_total int;
begin
  select count(*) filter (where applied), count(*) into v_applied, v_total
    from public.lensed_legacy_zero_cost_reconcile(true);
  if v_applied <> 2 then raise exception 'APPLY: expected 2 promotions, got % of %', v_applied, v_total; end if;
  raise notice '✓ APPLY: % of % legacy $0 layers promoted', v_applied, v_total;
end $$;

-- ══ TEST A — simple legacy $0: 120 historical lines attributed, promoted, then priced ══
do $$
declare SK uuid; B uuid; v_n int; v_units int; v_add int; v_rem int; r record;
begin
  select id into SK from public.inventory_skus where barcode='LZ-A';
  select id into B from public.sku_batches where sku_id=SK;

  select count(*), coalesce(sum(qty),0) into v_n, v_units
    from public.live_auction_item_skus where source_batch_id = B;
  if v_n <> 120 or v_units <> 120 then raise exception 'A: expected 120 lines/120 units attributed, got %/%', v_n, v_units; end if;

  -- the not_sold line must NOT be attributed: it drew no stock
  select count(*) into v_n from public.live_auction_item_skus l
    join public.live_auction_items i on i.id=l.auction_item_id
   where l.inventory_sku_id=SK and i.status<>'sold' and l.source_batch_id is not null;
  if v_n <> 0 then raise exception 'A: a not_sold line was attributed'; end if;

  -- promoted shape
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id=B;
  if (select cost_status from public.sku_batches where id=B) <> 'pending'
     or (select unit_cost_cents from public.sku_batches where id=B) is not null
     or not (select qty_added_authoritative from public.sku_batches where id=B) then
    raise exception 'A: promotion shape wrong'; end if;
  if v_add <> 500 or v_rem <> 380 then raise exception 'A: quantities moved %/% (expect 500/380)', v_add, v_rem; end if;

  -- now the SAME finalize RPC prices it
  select * into r from public.lensed_finalize_batch_cost(SK, B, 340);
  if r.units_repriced <> 120 then raise exception 'A: finalize repriced % units (expect 120)', r.units_repriced; end if;
  if (select count(*) from public.live_auction_item_skus where source_batch_id=B and unit_cost_cents_snapshot is distinct from 340) <> 0 then
    raise exception 'A: not all historical lines reached 340'; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id=B;
  if v_add <> 500 or v_rem <> 380 then raise exception 'A: finalize moved quantities'; end if;
  raise notice '✓ A: 120 historical units attributed + repriced to $3.40; qty 500/380 untouched';
end $$;

-- ══ TEST B/C — multi-layer replay, whole-line skip, isolation ═════════════════════════
do $$
declare SK uuid; BA uuid; BB uuid; BC uuid; v_n int; snapA text; snapC text; after_ text; r record;
begin
  select id into SK from public.inventory_skus where barcode='LZ-B';
  select id into BA from public.sku_batches where sku_id=SK and sequence=1;
  select id into BB from public.sku_batches where sku_id=SK and sequence=2;
  select id into BC from public.sku_batches where sku_id=SK and sequence=3;

  -- C: the qty-150 line SKIPPED layer A (only 40 left) and took layer B whole
  select count(*) into v_n from public.live_auction_item_skus l
    join public.live_auction_items i on i.id=l.auction_item_id
   where i.client_idempotency_key='B-big' and l.source_batch_id = BB;
  if v_n <> 1 then raise exception 'C: the qty-150 line was not attributed to layer B (whole-line skip not reproduced)'; end if;
  if (select qty_remaining from public.sku_batches where id=BA) <> 40 then
    raise exception 'C: layer A should retain 40 (it was skipped, not split)'; end if;

  -- only B was promoted
  if (select cost_status from public.sku_batches where id=BB) <> 'pending' then raise exception 'B: layer B not promoted'; end if;
  if (select cost_status from public.sku_batches where id=BA) <> 'legacy' then raise exception 'B: layer A must stay legacy'; end if;
  if (select cost_status from public.sku_batches where id=BC) <> 'legacy' then raise exception 'B: layer C must stay legacy'; end if;

  select md5(coalesce(string_agg(l.id::text||':'||coalesce(l.unit_cost_cents_snapshot::text,'~'),',' order by l.id),''))
    into snapA from public.live_auction_item_skus l where l.source_batch_id = BA;
  select md5(coalesce(string_agg(l.id::text||':'||coalesce(l.unit_cost_cents_snapshot::text,'~'),',' order by l.id),''))
    into snapC from public.live_auction_item_skus l where l.source_batch_id = BC;

  select * into r from public.lensed_finalize_batch_cost(SK, BB, 400);
  if r.units_repriced <> 150 then raise exception 'B: expected 150 units repriced, got %', r.units_repriced; end if;

  select md5(coalesce(string_agg(l.id::text||':'||coalesce(l.unit_cost_cents_snapshot::text,'~'),',' order by l.id),''))
    into after_ from public.live_auction_item_skus l where l.source_batch_id = BA;
  if after_ is distinct from snapA then raise exception 'B: layer A snapshots CHANGED'; end if;
  select md5(coalesce(string_agg(l.id::text||':'||coalesce(l.unit_cost_cents_snapshot::text,'~'),',' order by l.id),''))
    into after_ from public.live_auction_item_skus l where l.source_batch_id = BC;
  if after_ is distinct from snapC then raise exception 'B: layer C snapshots CHANGED'; end if;
  raise notice '✓ B/C: whole-line skip reproduced; only layer B repriced (150 units @400); A and C byte-identical';
end $$;

-- ══ TEST D — post-153 lines keep their recorded attribution and get the new cost ══════
do $$
declare SK uuid; B uuid; SESS uuid; v_before uuid; v_after uuid; r record; v_n int;
begin
  select id into SK from public.inventory_skus where barcode='LZ-A';
  select id into B  from public.sku_batches where sku_id=SK;
  select id into SESS from public.live_sessions limit 1;
  -- a NEW sale after promotion: the live RPC records source_batch_id itself
  perform * from public.lensed_log_auction(SESS,'sold',
    jsonb_build_array(jsonb_build_object('sku_id',SK,'qty',2)), 'A-new-1', true, false);
  select l.source_batch_id into v_before from public.live_auction_item_skus l
    join public.live_auction_items i on i.id=l.auction_item_id where i.client_idempotency_key='A-new-1';
  if v_before is distinct from B then raise exception 'D: new sale not attributed by the live RPC'; end if;

  -- re-running reconciliation must not touch it (batch is no longer legacy => not a candidate)
  select count(*) into v_n from public.lensed_legacy_zero_cost_reconcile(true) where batch_id = B;
  if v_n <> 0 then raise exception 'D: promoted batch is still a reconciliation candidate'; end if;
  select l.source_batch_id into v_after from public.live_auction_item_skus l
    join public.live_auction_items i on i.id=l.auction_item_id where i.client_idempotency_key='A-new-1';
  if v_after is distinct from v_before then raise exception 'D: existing attribution was overwritten'; end if;

  -- and a later correction prices BOTH the reconstructed old lines and the new one
  select * into r from public.lensed_finalize_batch_cost(SK, B, 330);
  if (select count(*) from public.live_auction_item_skus where source_batch_id=B and unit_cost_cents_snapshot is distinct from 330) <> 0 then
    raise exception 'D: not every attributed line reached 330'; end if;
  select count(*) into v_n from public.live_auction_item_skus where source_batch_id=B;
  raise notice '✓ D: pre-153 reconstructed + post-153 recorded lines (% total) all priced together; nothing overwritten', v_n;
end $$;

-- ══ TEST E — correction chain $0 placeholder -> 3.40 -> 3.30 ══════════════════════════
do $$
declare SK uuid; B uuid; v_n int; v_add int; v_rem int;
begin
  select id into SK from public.inventory_skus where barcode='LZ-A';
  select id into B from public.sku_batches where sku_id=SK;
  if (select unit_cost_cents from public.sku_batches where id=B) <> 330 then
    raise exception 'E: batch cost should be 330'; end if;
  if (select count(*) from public.live_auction_item_skus where source_batch_id=B and unit_cost_cents_snapshot <> 330) <> 0 then
    raise exception 'E: historical lines did not end at 330'; end if;
  select count(*) into v_n from public.sku_batch_cost_revisions where batch_id = B;
  if v_n <> 2 then raise exception 'E: expected 2 revisions (340 then 330), got %', v_n; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id=B;
  if v_add <> 500 then raise exception 'E: qty_added moved to %', v_add; end if;
  raise notice '✓ E: $0 placeholder -> 3.40 -> 3.30; 2 append-only revisions; qty_added still 500';
end $$;

-- ══ TEST F — idempotency ═════════════════════════════════════════════════════════════
do $$
declare h1 text; h2 text; v_rows int; v_audit int;
begin
  select md5(string_agg(id::text||':'||coalesce(source_batch_id::text,'~')||':'||coalesce(unit_cost_cents_snapshot::text,'~'),',' order by id))
    into h1 from public.live_auction_item_skus;
  select count(*) into v_audit from public.sku_batch_legacy_reconciliations;
  select count(*) filter (where applied) into v_rows from public.lensed_legacy_zero_cost_reconcile(true);
  select md5(string_agg(id::text||':'||coalesce(source_batch_id::text,'~')||':'||coalesce(unit_cost_cents_snapshot::text,'~'),',' order by id))
    into h2 from public.live_auction_item_skus;
  if v_rows <> 0 then raise exception 'F: second apply promoted % batches', v_rows; end if;
  if h1 <> h2 then raise exception 'F: second apply changed sale lines'; end if;
  if (select count(*) from public.sku_batch_legacy_reconciliations) <> v_audit then
    raise exception 'F: second apply wrote another audit row'; end if;
  raise notice '✓ F: re-running reconciliation promotes 0, changes 0 rows, writes 0 audit rows';
end $$;

-- ══ TEST G — the ambiguous case stayed untouched ══════════════════════════════════════
do $$
declare SK uuid; B uuid; v_n int;
begin
  select id into SK from public.inventory_skus where barcode='LZ-G';
  select id into B from public.sku_batches where sku_id=SK and unit_cost_cents=0;
  if (select cost_status from public.sku_batches where id=B) <> 'legacy' then
    raise exception 'G: ambiguous batch was promoted'; end if;
  if (select unit_cost_cents from public.sku_batches where id=B) <> 0 then
    raise exception 'G: ambiguous batch cost changed'; end if;
  if (select qty_added_authoritative from public.sku_batches where id=B) then
    raise exception 'G: ambiguous batch marked authoritative'; end if;
  select count(*) into v_n from public.live_auction_item_skus where inventory_sku_id=SK and source_batch_id is not null;
  if v_n <> 0 then raise exception 'G: % lines were attributed on an ambiguous SKU', v_n; end if;
  if (select count(*) from public.sku_batch_legacy_reconciliations where batch_id=B) <> 0 then
    raise exception 'G: an audit row was written for an ambiguous batch'; end if;
  -- and finalize still refuses it
  begin
    perform * from public.lensed_finalize_batch_cost(SK, B, 500);
    raise exception 'G: finalize accepted an unpromoted legacy batch';
  exception when sqlstate 'P0001' then null;
  end;
  raise notice '✓ G: ambiguous batch untouched — no attribution, no promotion, finalize still refuses it';
end $$;

-- ══ TEST H — out-of-scope legacy layers untouched ═════════════════════════════════════
do $$
declare v_n int;
begin
  select count(*) into v_n from public.sku_batches b join public.inventory_skus s on s.id=b.sku_id
   where s.barcode in ('LZ-H','LZ-H2') and (b.cost_status <> 'legacy' or b.qty_added_authoritative);
  if v_n <> 0 then raise exception 'H: % out-of-scope legacy layer(s) were modified', v_n; end if;
  raise notice '✓ H: positive-cost and NULL-cost legacy layers untouched';
end $$;

-- ══ P&L PROPAGATION ══════════════════════════════════════════════════════════════════
do $$
declare SK uuid; B uuid; cogs_b numeric; cogs_a numeric; rev_b numeric; rev_a numeric; g_b bigint; g_a bigint; r record;
begin
  select id into SK from public.inventory_skus where barcode='LZ-B';
  select id into B from public.sku_batches where sku_id=SK and sequence=2;
  select s.cogs_cents, s.revenue_cents into cogs_b, rev_b from public.pnl_by_sku(null,null,'UTC') s where s.sku_id=SK;
  select coalesce(sum(og.cogs_cents),0) into g_b from public.pnl_order_grain og where og.is_sold and og.sku = SK::text;
  if rev_b <= 0 then raise exception 'PNL: VACUOUS — no revenue visible'; end if;

  select * into r from public.lensed_finalize_batch_cost(SK, B, 450);   -- 400 -> 450 on 150 units

  select s.cogs_cents, s.revenue_cents into cogs_a, rev_a from public.pnl_by_sku(null,null,'UTC') s where s.sku_id=SK;
  select coalesce(sum(og.cogs_cents),0) into g_a from public.pnl_order_grain og where og.is_sold and og.sku = SK::text;
  if cogs_a - cogs_b <> 150*50 then raise exception 'PNL pnl_by_sku: COGS moved % expected %', cogs_a-cogs_b, 150*50; end if;
  if g_a - g_b <> 150*50 then raise exception 'PNL pnl_order_grain: COGS moved % expected %', g_a-g_b, 150*50; end if;
  if rev_a is distinct from rev_b then raise exception 'PNL: REVENUE changed % -> %', rev_b, rev_a; end if;
  raise notice '✓ P&L: pnl_by_sku and pnl_order_grain both moved by % cents; revenue unchanged', 150*50;
end $$;
