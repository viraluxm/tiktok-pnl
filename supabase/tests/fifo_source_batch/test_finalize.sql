-- Behavioral assertions for migration 151 — lensed_finalize_batch_cost.
--
-- Runs after: bootstrap -> 083 -> 105 -> seed_legacy -> 149 -> 150 -> 151 -> P&L surfaces.
-- The real migration-103 P&L functions and the prod-only pnl_order_grain view are installed
-- in this same database, so §10 proves propagation through the ACTUAL reporting surfaces
-- rather than re-implementing their arithmetic.
--
-- Every negative assertion reports the cardinality it examined (CONVENTIONS.md rule 1).

-- Shared helper: bind one qty-N sale for a SKU and give it a capture_events row so the
-- P&L surfaces (which key on capture_events.order_id) can see it.
create or replace function pg_temp.sell(p_sess uuid, p_sku uuid, p_qty int, p_order text,
                                        p_price_cents int, p_when timestamptz)
returns void language plpgsql as $$
declare A uuid := '11111111-1111-1111-1111-111111111111';
begin
  perform * from public.lensed_log_auction(p_sess, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', p_sku, 'qty', p_qty)), p_order, false, false);
  insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
    values (A, p_order, p_price_cents, p_when);
end $$;

do $$
declare
  A    uuid := '11111111-1111-1111-1111-111111111111';
  ORG1 uuid := '22222222-2222-2222-2222-222222222222';
  SESS uuid;
  SK1 uuid; B1 uuid;
  SK2 uuid; B2 uuid;
  SK3 uuid; B3 uuid;
  SK4 uuid; B4A uuid; B4B uuid; B4C uuid;
  SK5 uuid; B5 uuid;
  SK6 uuid; B6 uuid;
  SK7 uuid; B7 uuid;
  SK9 uuid; B9 uuid; B9B uuid;
  r record; v_n int; v_sum bigint; v_add int; v_rem int; v_qoh int; v_msg text;
  v_snap_a jsonb; v_snap_c jsonb; v_after jsonb;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status, title, started_at)
    values (A, 'live', 'Finalize tests', now()) returning id into SESS;

  -- ══ TEST 1 — pending cost backfill (THE primary business requirement) ══════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 101, 'F1', 'Pending backfill', null, 0) returning id into SK1;
  select public.lensed_add_batch(SK1, 500, null) into B1;
  perform pg_temp.sell(SESS, SK1, 120, 'F1-1', 200000, now());

  -- BEFORE finalization
  select count(*), coalesce(sum(l.qty),0) into v_n, v_sum
    from public.live_auction_item_skus l where l.source_batch_id = B1;
  if v_n = 0 then raise exception 'T1: VACUOUS — nothing attributed to the batch'; end if;
  if v_sum <> 120 then raise exception 'T1: expected 120 attributed units, got %', v_sum; end if;
  if exists (select 1 from public.live_auction_item_skus where source_batch_id = B1
               and unit_cost_cents_snapshot is not null) then
    raise exception 'T1: a pending layer must snapshot NULL before finalization'; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B1;
  if (v_add, v_rem) is distinct from (500, 380) then
    raise exception 'T1: expected 500/380 before, got %/%', v_add, v_rem; end if;

  -- FINALIZE at $3.40
  select * into r from public.lensed_finalize_batch_cost(SK1, B1, 340);
  if r.old_unit_cost_cents is not null then raise exception 'T1: old cost should be NULL (pending)'; end if;
  if r.new_unit_cost_cents <> 340 then raise exception 'T1: new cost %', r.new_unit_cost_cents; end if;
  if r.lines_repriced <> 1 or r.units_repriced <> 120 then
    raise exception 'T1: expected 1 line / 120 units repriced, got %/%', r.lines_repriced, r.units_repriced; end if;
  if r.prev_cogs_cents <> 0 then raise exception 'T1: prev COGS should be 0 (unknown), got %', r.prev_cogs_cents; end if;
  if r.new_cogs_cents <> 120*340 then raise exception 'T1: new COGS expected % got %', 120*340, r.new_cogs_cents; end if;
  if r.cogs_delta_cents <> 120*340 then raise exception 'T1: delta expected % got %', 120*340, r.cogs_delta_cents; end if;
  if not r.revision_recorded then raise exception 'T1: a real correction must record a revision'; end if;

  -- AFTER
  select count(*) into v_n from public.live_auction_item_skus
   where source_batch_id = B1 and unit_cost_cents_snapshot = 340;
  if v_n <> 1 then raise exception 'T1: expected 1 repriced line, got %', v_n; end if;
  select coalesce(sum(l.qty * l.unit_cost_cents_snapshot),0) into v_sum
    from public.live_auction_item_skus l where l.source_batch_id = B1;
  if v_sum <> 120*340 then raise exception 'T1: historical COGS expected % got %', 120*340, v_sum; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B1;
  if (v_add, v_rem) is distinct from (500, 380) then
    raise exception 'T1: QUANTITIES MOVED — %/% (must still be 500/380)', v_add, v_rem; end if;
  if (select unit_cost_cents from public.sku_batches where id = B1) <> 340
     or (select cost_status from public.sku_batches where id = B1) <> 'final' then
    raise exception 'T1: layer not finalized'; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SK1;
  if v_qoh <> 380 then raise exception 'T1: qty_on_hand moved to %', v_qoh; end if;
  -- the SKU cost scalar mirrors the front layer immediately, not in 60s
  if (select unit_cost_cents from public.inventory_skus where id = SK1) <> 340 then
    raise exception 'T1: SKU cost scalar not mirrored'; end if;
  raise notice '✓ T1: 500 added / 120 sold pending / $3.40 entered -> 120 units repriced, COGS +%, quantities untouched', 120*340;

  -- ══ TEST 2 — known cost at entry still behaves exactly as before ═══════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 102, 'F2', 'Known cost', null, 0) returning id into SK2;
  select public.lensed_add_batch(SK2, 500, 340) into B2;
  if (select cost_status from public.sku_batches where id = B2) <> 'final' then
    raise exception 'T2: a cost given at entry must be final immediately'; end if;
  perform pg_temp.sell(SESS, SK2, 120, 'F2-1', 200000, now());

  select l.unit_cost_cents_snapshot, l.source_batch_id into v_n, B2
    from public.live_auction_item_skus l
    join public.live_auction_items i on i.id = l.auction_item_id
   where i.client_idempotency_key = 'F2-1';
  if v_n <> 340 then raise exception 'T2: snapshot should already be 340, got %', v_n; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B2;
  if (v_add, v_rem) is distinct from (500, 380) then raise exception 'T2: quantities %/%', v_add, v_rem; end if;
  if exists (select 1 from public.sku_batch_cost_revisions where batch_id = B2) then
    raise exception 'T2: the known-cost path must need NO finalize step'; end if;
  raise notice '✓ T2: known cost at entry — snapshot correct at bind, no finalize needed, no revision';

  -- ══ TEST 3 — correcting an already-known cost ($3.40 -> $3.55) ════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 103, 'F3', 'Correction', null, 0) returning id into SK3;
  select public.lensed_add_batch(SK3, 500, 340) into B3;
  perform pg_temp.sell(SESS, SK3, 120, 'F3-1', 200000, now());

  select * into r from public.lensed_finalize_batch_cost(SK3, B3, 355);
  if r.old_unit_cost_cents <> 340 then raise exception 'T3: old cost %', r.old_unit_cost_cents; end if;
  if r.units_repriced <> 120 then raise exception 'T3: units repriced %', r.units_repriced; end if;
  if r.cogs_delta_cents <> 120*15 then raise exception 'T3: delta expected % got %', 120*15, r.cogs_delta_cents; end if;
  select coalesce(sum(l.qty * l.unit_cost_cents_snapshot),0) into v_sum
    from public.live_auction_item_skus l where l.source_batch_id = B3;
  if v_sum <> 120*355 then raise exception 'T3: historical COGS expected % got %', 120*355, v_sum; end if;
  if (select unit_cost_cents from public.sku_batches where id = B3) <> 355 then
    raise exception 'T3: remaining inventory not repriced'; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B3;
  if (v_add, v_rem) is distinct from (500, 380) then raise exception 'T3: quantities moved %/%', v_add, v_rem; end if;
  raise notice '✓ T3: $3.40 -> $3.55 repriced 120 units, COGS delta % cents, quantities untouched', 120*15;

  -- ══ TEST 4 — ONLY the corrected batch reprices ════════════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 104, 'F4', 'Three layers', null, 0) returning id into SK4;
  select public.lensed_add_batch(SK4, 100, 300)  into B4A;
  select public.lensed_add_batch(SK4, 100, null) into B4B;   -- pending
  select public.lensed_add_batch(SK4, 100, 500)  into B4C;
  -- drain A, then B, then into C, with ordinary qty-1 behaviour at the boundaries
  perform pg_temp.sell(SESS, SK4, 100, 'F4-A', 50000, now());
  perform pg_temp.sell(SESS, SK4, 60,  'F4-B', 30000, now());
  perform pg_temp.sell(SESS, SK4, 100, 'F4-C', 50000, now());   -- B has 40 left -> draws C

  -- freeze A's and C's snapshots for a byte-comparison
  select jsonb_agg(jsonb_build_array(l.id::text, l.unit_cost_cents_snapshot, l.qty) order by l.id)
    into v_snap_a from public.live_auction_item_skus l where l.source_batch_id = B4A;
  select jsonb_agg(jsonb_build_array(l.id::text, l.unit_cost_cents_snapshot, l.qty) order by l.id)
    into v_snap_c from public.live_auction_item_skus l where l.source_batch_id = B4C;
  if v_snap_a is null or v_snap_c is null then raise exception 'T4: VACUOUS — A or C has no attributed lines'; end if;

  select * into r from public.lensed_finalize_batch_cost(SK4, B4B, 400);
  if r.units_repriced <> 60 then raise exception 'T4: expected 60 units from B, got %', r.units_repriced; end if;

  select jsonb_agg(jsonb_build_array(l.id::text, l.unit_cost_cents_snapshot, l.qty) order by l.id)
    into v_after from public.live_auction_item_skus l where l.source_batch_id = B4A;
  if v_after is distinct from v_snap_a then raise exception 'T4: batch A snapshots CHANGED'; end if;
  select jsonb_agg(jsonb_build_array(l.id::text, l.unit_cost_cents_snapshot, l.qty) order by l.id)
    into v_after from public.live_auction_item_skus l where l.source_batch_id = B4C;
  if v_after is distinct from v_snap_c then raise exception 'T4: batch C snapshots CHANGED'; end if;
  if exists (select 1 from public.live_auction_item_skus where source_batch_id = B4B
               and unit_cost_cents_snapshot is distinct from 400) then
    raise exception 'T4: not all of B repriced'; end if;
  -- no attribution and no quantity moved anywhere on this SKU
  -- Expected landing (Option X = oldest layer that covers the WHOLE line, never split):
  --   sell 100 -> A covers it            -> A: 100 added / 0 remaining
  --   sell 60  -> B is oldest covering 60 -> B: 100 added / 40 remaining
  --   sell 100 -> B has only 40, so it is SKIPPED, C covers it -> C: 100 added / 0 remaining
  select count(*) into v_n from public.sku_batches where sku_id = SK4
    and (qty_added, qty_remaining) is distinct from
        (100, case id when B4A then 0 when B4B then 40 when B4C then 0 end);
  if v_n <> 0 then raise exception 'T4: % layer(s) have unexpected quantities', v_n; end if;
  raise notice '✓ T4: only batch B repriced (60 units @400); A and C byte-identical; no quantity or attribution moved';

  -- ══ TEST 5 — legitimate zero cost ═════════════════════════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 105, 'F5', 'Genuinely free', null, 0) returning id into SK5;
  select public.lensed_add_batch(SK5, 100, 0) into B5;
  if (select cost_status from public.sku_batches where id = B5) <> 'final' then
    raise exception 'T5: a genuine $0 must be FINAL, never pending'; end if;
  perform pg_temp.sell(SESS, SK5, 10, 'F5-1', 5000, now());
  select l.unit_cost_cents_snapshot into v_n from public.live_auction_item_skus l
    where l.source_batch_id = B5;
  if v_n is distinct from 0 then raise exception 'T5: snapshot expected 0, got %', v_n; end if;
  if not exists (select 1 from public.live_auction_item_skus where source_batch_id = B5) then
    raise exception 'T5: free stock must still be attributed'; end if;
  -- and a free layer can still be corrected later
  select * into r from public.lensed_finalize_batch_cost(SK5, B5, 100);
  if r.old_unit_cost_cents <> 0 then raise exception 'T5: old cost should be 0 not NULL — the distinction 149 exists for'; end if;
  if r.cogs_delta_cents <> 10*100 then raise exception 'T5: delta expected % got %', 10*100, r.cogs_delta_cents; end if;
  raise notice '✓ T5: $0 is final + attributed + never flagged pending; $0 -> $1 reprices safely';

  -- ══ TEST 6 — idempotency (Option A: an exact replay records nothing) ══════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 106, 'F6', 'Idempotent', null, 0) returning id into SK6;
  select public.lensed_add_batch(SK6, 200, null) into B6;
  perform pg_temp.sell(SESS, SK6, 50, 'F6-1', 20000, now());

  select * into r from public.lensed_finalize_batch_cost(SK6, B6, 340);
  if not r.revision_recorded then raise exception 'T6: first call must record a revision'; end if;
  select coalesce(sum(l.qty * l.unit_cost_cents_snapshot),0) into v_sum
    from public.live_auction_item_skus l where l.source_batch_id = B6;

  select * into r from public.lensed_finalize_batch_cost(SK6, B6, 340);   -- exact replay
  if r.lines_repriced <> 0 or r.units_repriced <> 0 then
    raise exception 'T6: replay moved % lines / % units', r.lines_repriced, r.units_repriced; end if;
  if r.cogs_delta_cents <> 0 then raise exception 'T6: replay delta % (must be 0)', r.cogs_delta_cents; end if;
  if r.revision_recorded then raise exception 'T6: a true no-op must NOT append a revision (documented Option A)'; end if;
  select count(*) into v_n from public.sku_batch_cost_revisions where batch_id = B6;
  if v_n <> 1 then raise exception 'T6: expected exactly 1 revision after a replay, got %', v_n; end if;
  select count(*) into v_n from public.live_auction_item_skus where source_batch_id = B6;
  if v_n <> 1 then raise exception 'T6: sale rows duplicated (%)', v_n; end if;
  if (select coalesce(sum(l.qty * l.unit_cost_cents_snapshot),0) from public.live_auction_item_skus l
        where l.source_batch_id = B6) <> v_sum then
    raise exception 'T6: COGS changed on replay'; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B6;
  if (v_add, v_rem) is distinct from (200, 150) then raise exception 'T6: quantities moved %/%', v_add, v_rem; end if;
  raise notice '✓ T6: replay = success, 0 lines moved, 0 delta, NO second revision, nothing doubled';

  -- ══ TEST 7 — two corrections in sequence (pending -> $4.00 -> $4.25) ══════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 107, 'F7', 'Twice corrected', null, 0) returning id into SK7;
  select public.lensed_add_batch(SK7, 100, null) into B7;
  perform pg_temp.sell(SESS, SK7, 40, 'F7-1', 20000, now());

  perform * from public.lensed_finalize_batch_cost(SK7, B7, 400);
  perform * from public.lensed_finalize_batch_cost(SK7, B7, 425);

  if exists (select 1 from public.live_auction_item_skus where source_batch_id = B7
               and unit_cost_cents_snapshot is distinct from 425) then
    raise exception 'T7: snapshots did not end at 425'; end if;
  select count(*) into v_n from public.sku_batch_cost_revisions where batch_id = B7;
  if v_n <> 2 then raise exception 'T7: expected 2 revisions (append-only), got %', v_n; end if;
  -- the audit reconciles to the final state: Σ deltas == final COGS − original COGS(0)
  select coalesce(sum(cogs_delta_cents),0) into v_sum from public.sku_batch_cost_revisions where batch_id = B7;
  if v_sum <> 40*425 then raise exception 'T7: Σ deltas % should reconcile to %', v_sum, 40*425; end if;
  -- and the two rows read as a chain: NULL->400, then 400->425
  if not exists (select 1 from public.sku_batch_cost_revisions
                  where batch_id = B7 and old_unit_cost_cents is null and new_unit_cost_cents = 400)
     or not exists (select 1 from public.sku_batch_cost_revisions
                  where batch_id = B7 and old_unit_cost_cents = 400 and new_unit_cost_cents = 425) then
    raise exception 'T7: revision chain is not NULL->400->425'; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = B7;
  if (v_add, v_rem) is distinct from (100, 60) then raise exception 'T7: quantities moved %/%', v_add, v_rem; end if;
  raise notice '✓ T7: pending -> 400 -> 425; two append-only revisions; Σ deltas reconcile to % cents', 40*425;

  -- ══ TEST 9 — delete/void protection, friendly error, FK intact ════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 109, 'F9', 'Delete guard', null, 0) returning id into SK9;
  select public.lensed_add_batch(SK9, 20, 700) into B9;
  select public.lensed_add_batch(SK9, 5, 800) into B9B;     -- so B9 is not the last layer
  perform pg_temp.sell(SESS, SK9, 4, 'F9-1', 4000, now());

  -- defeat the untouched guard exactly as the audit showed is possible
  perform public.lensed_edit_batch(SK9, B9, 20, 700, true);
  select qty_remaining, qty_added into v_rem, v_add from public.sku_batches where id = B9;
  if v_rem <> v_add then raise exception 'T9: setup failed — guard not defeated (%/%)', v_rem, v_add; end if;

  v_msg := null;
  begin
    perform public.lensed_delete_batch(SK9, B9);
    v_msg := '__SUCCEEDED__';
  exception
    when sqlstate 'P0001' then get stacked diagnostics v_msg = message_text;
    when foreign_key_violation then v_msg := '__RAW_FK__';
  end;
  if v_msg = '__SUCCEEDED__' then raise exception 'T9: consumed layer WAS DELETED'; end if;
  if v_msg = '__RAW_FK__' then raise exception 'T9: raw 23503 surfaced — the friendly pre-check did not fire'; end if;
  if position('BATCH_HAS_CONSUMPTION' in v_msg) = 0 then
    raise exception 'T9: wrong domain error: %', v_msg; end if;

  -- everything intact after the refusal
  if (select count(*) from public.sku_batches where id = B9) <> 1 then raise exception 'T9: batch vanished'; end if;
  if (select count(*) from public.live_auction_item_skus where source_batch_id = B9) <> 1 then
    raise exception 'T9: attribution lost'; end if;
  select qty_remaining into v_rem from public.sku_batches where id = B9;
  if v_rem <> 20 then raise exception 'T9: quantity corrupted by the failed delete (%)', v_rem; end if;
  -- and the FK is still the last word (prove it can still fire, on a direct delete)
  v_msg := null;
  begin
    delete from public.sku_batches where id = B9;
    v_msg := '__SUCCEEDED__';
  exception when foreign_key_violation then v_msg := 'fk';
  end;
  if v_msg <> 'fk' then raise exception 'T9: the FK did not fire on a direct DELETE — it has been weakened'; end if;
  raise notice '✓ T9: friendly BATCH_HAS_CONSUMPTION from the RPC; FK still fires on a direct DELETE; nothing corrupted';

  raise notice '── finalize assertions passed ──';
end $$;

-- ══ TEST 9b — lensed_void_batch gets the same protection ═══════════════════════════════
do $$
declare
  A uuid := '11111111-1111-1111-1111-111111111111';
  ORG1 uuid := '22222222-2222-2222-2222-222222222222';
  SESS uuid; SKV uuid; BV uuid; v_msg text; v_qoh int;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status, started_at) values (A, 'live', now()) returning id into SESS;
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 110, 'FV', 'Void guard', null, 0) returning id into SKV;
  -- a 'viewtrack' layer is the only kind void_batch will touch
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, qty_added_authoritative,
                                  unit_cost_cents, cost_status, sequence, source, external_ref)
    values (A, ORG1, SKV, 10, 10, true, 900, 'final', 1, 'viewtrack', 'vt-1') returning id into BV;
  update public.inventory_skus set qty_on_hand = 10 where id = SKV;

  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SKV, 'qty', 3)), 'FV-1', false, false);
  -- defeat void's identical untouched proof
  perform public.lensed_edit_batch(SKV, BV, 10, 900, true);

  v_msg := null;
  begin
    perform * from public.lensed_void_batch(ORG1, BV);
    v_msg := '__SUCCEEDED__';
  exception
    when sqlstate 'P0001' then get stacked diagnostics v_msg = message_text;
    when foreign_key_violation then v_msg := '__RAW_FK__';
  end;
  if v_msg = '__SUCCEEDED__' then raise exception 'T9b: a consumed viewtrack layer was VOIDED'; end if;
  if v_msg = '__RAW_FK__' then raise exception 'T9b: raw 23503 surfaced from void_batch'; end if;
  if position('BATCH_HAS_CONSUMPTION' in v_msg) = 0 then raise exception 'T9b: wrong error: %', v_msg; end if;
  if (select count(*) from public.sku_batches where id = BV) <> 1 then raise exception 'T9b: layer vanished'; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SKV;
  if v_qoh <> 10 then raise exception 'T9b: qty_on_hand corrupted (%)', v_qoh; end if;
  raise notice '✓ T9b: lensed_void_batch refuses a consumed layer with the same domain error';
end $$;

-- ══ TEST 10 — propagation through the REAL P&L surfaces ════════════════════════════════
-- These are migration 103's own functions plus the prod-only pnl_order_grain view, running
-- against this database. Nothing about their arithmetic is re-implemented here.
do $$
declare
  A uuid := '11111111-1111-1111-1111-111111111111';
  ORG1 uuid := '22222222-2222-2222-2222-222222222222';
  SESS uuid; SKP uuid; BP uuid;
  cogs_before numeric; cogs_after numeric; raw_before numeric; raw_after numeric;
  rev_before numeric; rev_after numeric;
  grain_before bigint; grain_after bigint;
  period_cogs_before numeric; period_cogs_after numeric;
  period_rev_before numeric; period_rev_after numeric;
  show_cogs_before numeric; show_cogs_after numeric;
  net_before numeric; net_after numeric;
  v_units bigint; v_n int;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status, title, started_at)
    values (A, 'live', 'P&L show', now()) returning id into SESS;
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 200, 'P1', 'P&L SKU', null, 0) returning id into SKP;
  select public.lensed_add_batch(SKP, 500, null) into BP;    -- pending
  perform pg_temp.sell(SESS, SKP, 100, 'P-1', 100000, now());

  -- BEFORE
  -- raw sale-line COGS (the value every surface below ultimately reads)
  select coalesce(sum(l.qty * coalesce(l.unit_cost_cents_snapshot, 0)), 0)
    into raw_before from public.live_auction_item_skus l where l.source_batch_id = BP;
  select coalesce(sum(og.cogs_cents),0) into grain_before
    from public.pnl_order_grain og where og.user_id = A and og.is_sold and og.sku = SKP::text;
  select s.cogs_cents, s.revenue_cents into cogs_before, rev_before
    from public.pnl_by_sku(null, null, 'UTC') s where s.sku_id = SKP;
  select coalesce(sum(p.cogs_cents),0), coalesce(sum(p.revenue_cents),0), coalesce(sum(p.net_profit_cents),0)
    into period_cogs_before, period_rev_before, net_before
    from public.pnl_by_period_as(array[A], null, null, 'UTC') p;
  select coalesce(sum(sh.cogs_cents),0) into show_cogs_before
    from public.pnl_by_show_as(array[A], null, null, 'UTC') sh where sh.session_id = SESS;

  if rev_before <= 0 then raise exception 'T10: VACUOUS — no revenue visible to pnl_by_sku'; end if;
  if cogs_before <> 0 then raise exception 'T10: pending COGS should read 0, got %', cogs_before; end if;

  -- FINALIZE
  perform * from public.lensed_finalize_batch_cost(SKP, BP, 340);

  -- AFTER
  select s.cogs_cents, s.revenue_cents into cogs_after, rev_after
    from public.pnl_by_sku(null, null, 'UTC') s where s.sku_id = SKP;
  select coalesce(sum(og.cogs_cents),0) into grain_after
    from public.pnl_order_grain og where og.user_id = A and og.is_sold and og.sku = SKP::text;
  select coalesce(sum(p.cogs_cents),0), coalesce(sum(p.revenue_cents),0), coalesce(sum(p.net_profit_cents),0)
    into period_cogs_after, period_rev_after, net_after
    from public.pnl_by_period_as(array[A], null, null, 'UTC') p;
  select coalesce(sum(sh.cogs_cents),0) into show_cogs_after
    from public.pnl_by_show_as(array[A], null, null, 'UTC') sh where sh.session_id = SESS;

  select coalesce(sum(l.qty * coalesce(l.unit_cost_cents_snapshot, 0)), 0)
    into raw_after from public.live_auction_item_skus l where l.source_batch_id = BP;
  if raw_after - raw_before <> 100*340 then
    raise exception 'T10 raw sale lines: COGS moved by % expected %', raw_after - raw_before, 100*340; end if;
  if cogs_after <> 100*340 then raise exception 'T10 pnl_by_sku: COGS expected % got %', 100*340, cogs_after; end if;
  if grain_after - grain_before <> 100*340 then
    raise exception 'T10 pnl_order_grain: COGS moved by % expected %', grain_after - grain_before, 100*340; end if;
  if period_cogs_after - period_cogs_before <> 100*340 then
    raise exception 'T10 pnl_by_period_as: COGS moved by % expected %', period_cogs_after - period_cogs_before, 100*340; end if;
  if show_cogs_after - show_cogs_before <> 100*340 then
    raise exception 'T10 pnl_by_show_as: COGS moved by % expected %', show_cogs_after - show_cogs_before, 100*340; end if;

  -- REVENUE MUST NOT MOVE on any surface
  if rev_after is distinct from rev_before then
    raise exception 'T10: pnl_by_sku REVENUE changed % -> %', rev_before, rev_after; end if;
  if period_rev_after is distinct from period_rev_before then
    raise exception 'T10: pnl_by_period_as REVENUE changed % -> %', period_rev_before, period_rev_after; end if;

  -- profit falls by exactly the COGS increase
  if net_before - net_after <> 100*340 then
    raise exception 'T10: net profit moved by % expected %', net_before - net_after, 100*340; end if;

  raise notice '✓ T10: pnl_by_sku, pnl_order_grain, pnl_by_period_as, pnl_by_show_as ALL moved by % cents; revenue unchanged; net profit fell by exactly the COGS rise', 100*340;
end $$;

-- ══ TEST 11 — the DIRECT-UPDATE bypass is closed at the table ══════════════════════════
-- Refusing the change inside lensed_edit_batch is not enough: migration 035b's generic
-- org-scoped RLS update policy lets any signed-in member PATCH sku_batches straight through
-- PostgREST. This asserts the guard trigger, which is what actually closes it.
do $$
declare
  A uuid := '11111111-1111-1111-1111-111111111111';
  ORG1 uuid := '22222222-2222-2222-2222-222222222222';
  SESS uuid; SKG uuid; BG uuid; BGL uuid; SKGL uuid; v_msg text; v_cost int; v_n int;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status, started_at) values (A, 'live', now()) returning id into SESS;
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 120, 'FG', 'Guard', null, 0) returning id into SKG;
  select public.lensed_add_batch(SKG, 50, 300) into BG;
  perform pg_temp.sell(SESS, SKG, 10, 'FG-1', 10000, now());

  -- (a) a raw UPDATE — exactly what PostgREST issues — must be REFUSED
  v_msg := null;
  begin
    update public.sku_batches set unit_cost_cents = 999 where id = BG;
    v_msg := '__SUCCEEDED__';
  exception when sqlstate 'P0001' then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg = '__SUCCEEDED__' then
    raise exception 'T11: DIRECT UPDATE changed an attributable cost — the bypass is still open'; end if;
  if position('COST_EDIT_REQUIRES_FINALIZE' in v_msg) = 0 then
    raise exception 'T11: wrong error from the guard: %', v_msg; end if;
  select unit_cost_cents into v_cost from public.sku_batches where id = BG;
  if v_cost <> 300 then raise exception 'T11: the refused update still mutated the row (%)', v_cost; end if;
  if exists (select 1 from public.live_auction_item_skus
              where source_batch_id = BG and unit_cost_cents_snapshot is distinct from 300) then
    raise exception 'T11: attributed snapshots drifted'; end if;

  -- (b) quantity-only direct writes still pass (the guard is narrow, not a blanket lock)
  update public.sku_batches set qty_remaining = 39 where id = BG;
  if (select qty_remaining from public.sku_batches where id = BG) <> 39 then
    raise exception 'T11: the guard blocked a QUANTITY write'; end if;
  update public.sku_batches set qty_remaining = 40 where id = BG;   -- restore

  -- (c) the sanctioned path still works, and IS able to change the cost
  perform * from public.lensed_finalize_batch_cost(SKG, BG, 999);
  if (select unit_cost_cents from public.sku_batches where id = BG) <> 999 then
    raise exception 'T11: finalize could not change the cost — the guard is too strict'; end if;
  if exists (select 1 from public.live_auction_item_skus
              where source_batch_id = BG and unit_cost_cents_snapshot is distinct from 999) then
    raise exception 'T11: finalize did not reprice'; end if;

  -- (d) the marker does not leak: a direct update AFTER a finalize in the same transaction
  --     must still be refused
  v_msg := null;
  begin
    update public.sku_batches set unit_cost_cents = 111 where id = BG;
    v_msg := '__SUCCEEDED__';
  exception when sqlstate 'P0001' then v_msg := 'guarded';
  end;
  if v_msg <> 'guarded' then
    raise exception 'T11: the transaction-local marker LEAKED past the finalize'; end if;

  -- (e) LEGACY layers are deliberately untouched by the guard (Part 7)
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 121, 'FGL', 'Guard legacy', null, 0) returning id into SKGL;
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
    values (A, ORG1, SKGL, 10, 10, 500, 1) returning id into BGL;   -- authoritative FALSE
  update public.sku_batches set unit_cost_cents = 650 where id = BGL;
  if (select unit_cost_cents from public.sku_batches where id = BGL) <> 650 then
    raise exception 'T11: the guard blocked a LEGACY cost edit — behaviour regressed'; end if;

  -- (f) and finalize refuses a legacy layer outright
  v_msg := null;
  begin
    perform * from public.lensed_finalize_batch_cost(SKGL, BGL, 700);
    v_msg := '__SUCCEEDED__';
  exception when sqlstate 'P0001' then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg = '__SUCCEEDED__' then raise exception 'T11: finalize accepted a LEGACY layer'; end if;
  if position('BATCH_NOT_ATTRIBUTABLE' in v_msg) = 0 then
    raise exception 'T11: wrong error for a legacy layer: %', v_msg; end if;

  select count(*) into v_n from public.sku_batches where id in (BG, BGL);
  if v_n <> 2 then raise exception 'T11: VACUOUS — fixtures missing'; end if;
  raise notice '✓ T11: direct UPDATE refused (and non-leaking); qty writes pass; finalize works; legacy untouched and unfinalizable';
end $$;

-- ══ Catalog + audit-shape assertions ═══════════════════════════════════════════════════
do $$
declare v_cnt int; v_pol int;
begin
  select count(*) into v_cnt from information_schema.tables
   where table_schema='public' and table_name='sku_batch_cost_revisions';
  if v_cnt <> 1 then raise exception 'CATALOG: audit table missing'; end if;

  -- append-only: SELECT + INSERT policies, and deliberately NO update/delete policy
  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename='sku_batch_cost_revisions';
  if v_pol <> 2 then raise exception 'CATALOG: expected exactly 2 policies (select+insert), found %', v_pol; end if;
  if exists (select 1 from pg_policies where schemaname='public'
              and tablename='sku_batch_cost_revisions' and cmd in ('UPDATE','DELETE')) then
    raise exception 'CATALOG: a revision must not be updatable or deletable';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.sku_batch_cost_revisions'::regclass) then
    raise exception 'CATALOG: RLS not enabled on the audit table';
  end if;

  -- signatures unchanged where they must be
  if pg_get_function_identity_arguments('public.lensed_edit_batch'::regproc)
     <> 'p_sku_id uuid, p_batch_id uuid, p_qty_remaining integer, p_unit_cost_cents integer, p_set_cost boolean' then
    raise exception 'CATALOG: lensed_edit_batch signature changed'; end if;
  if pg_get_function_identity_arguments('public.lensed_delete_batch'::regproc)
     <> 'p_sku_id uuid, p_batch_id uuid' then
    raise exception 'CATALOG: lensed_delete_batch signature changed'; end if;
  if pg_get_function_identity_arguments('public.lensed_finalize_batch_cost'::regproc)
     <> 'p_sku_id uuid, p_batch_id uuid, p_unit_cost_cents integer' then
    raise exception 'CATALOG: lensed_finalize_batch_cost signature unexpected'; end if;

  -- The grant the app depends on. scripts/check-rpc-grants.mjs asserts this against the LIVE
  -- database, so it necessarily fails until 151 is applied there; proving it here closes the
  -- loop without touching production. has_function_privilege is a POSITIVE assertion — it
  -- cannot pass vacuously the way a NOT EXISTS over the catalog could.
  if not has_function_privilege('authenticated',
        'public.lensed_finalize_batch_cost(uuid,uuid,int)', 'EXECUTE') then
    raise exception 'CATALOG: authenticated lacks EXECUTE on lensed_finalize_batch_cost — check:rpc-grants would fail after apply';
  end if;
  if has_function_privilege('anon', 'public.lensed_void_batch(uuid,uuid)', 'EXECUTE') then
    raise exception 'CATALOG: void_batch must stay revoked from anon';
  end if;

  -- The guard trigger is what actually closes the direct-PostgREST cost path.
  select count(*) into v_cnt from pg_trigger t
   where t.tgrelid = 'public.sku_batches'::regclass
     and t.tgname = 'sku_batches_guard_cost_write' and not t.tgisinternal;
  if v_cnt <> 1 then raise exception 'CATALOG: the cost-write guard trigger is missing'; end if;

  select count(*) into v_cnt from public.sku_batch_cost_revisions;
  if v_cnt = 0 then raise exception 'CATALOG: VACUOUS — no revisions were recorded by any test'; end if;
  raise notice '✓ CATALOG: audit table RLS-enabled, append-only (2 policies), signatures stable, % revisions recorded', v_cnt;
end $$;
