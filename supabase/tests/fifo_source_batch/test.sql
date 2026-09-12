-- Behavioral assertions for migrations 149 + 150 (FIFO source-batch attribution +
-- explicit batch cost state + authoritative received quantity).
--
-- Runs inside a throwaway Postgres (see run.sh) after:
--   bootstrap.sql -> 083 -> 105 -> seed_legacy.sql -> 149 -> 150
--
-- Any failed assertion RAISEs and aborts (ON_ERROR_STOP=1). Every negative assertion also
-- reports the cardinality of the set it examined, per supabase/migrations/CONVENTIONS.md:
-- a pass over zero rows is inconclusive, not a pass.

-- ════════════════════════════════════════════════════════════════════════════════════
-- TEST H (first, because it is about what the MIGRATION did, before we add new data):
--   legacy rows are untouched by 149 + 150.
-- ════════════════════════════════════════════════════════════════════════════════════
do $$
declare v_n int; v_diff int; v_null int;
begin
  select count(*) into v_n from legacy_snapshot;
  if v_n = 0 then raise exception 'H: VACUOUS — legacy_snapshot is empty, nothing was examined'; end if;

  -- (a) not one legacy sale line changed in any pre-existing column
  select count(*) into v_diff
    from legacy_snapshot s
    join public.live_auction_item_skus l on l.id = s.id
   where (l.inventory_sku_id, l.qty, l.unit_cost_cents_snapshot, l.sku_number_snapshot,
          l.title_snapshot, l.short_at_bind)
      is distinct from
         (s.inventory_sku_id, s.qty, s.unit_cost_cents_snapshot, s.sku_number_snapshot,
          s.title_snapshot, s.short_at_bind);
  if v_diff <> 0 then raise exception 'H(a): % of % legacy sale lines were modified', v_diff, v_n; end if;

  -- (b) every legacy sale line is HONESTLY unattributed
  select count(*) into v_null from public.live_auction_item_skus l
    join legacy_snapshot s on s.id = l.id where l.source_batch_id is not null;
  if v_null <> 0 then raise exception 'H(b): % legacy lines were back-filled with a source_batch_id', v_null; end if;

  -- (c) no legacy row vanished or appeared
  if (select count(*) from public.live_auction_item_skus) <> v_n then
    raise exception 'H(c): sale-line count changed: was %, now %', v_n, (select count(*) from public.live_auction_item_skus);
  end if;

  raise notice '✓ H: % legacy sale lines examined — 0 modified, 0 back-filled, count stable', v_n;
end $$;

do $$
declare v_n int; v_diff int; v_bad int;
begin
  select count(*) into v_n from legacy_batch_snapshot;
  if v_n = 0 then raise exception 'H2: VACUOUS — legacy_batch_snapshot is empty'; end if;

  select count(*) into v_diff
    from legacy_batch_snapshot s join public.sku_batches b on b.id = s.id
   where (b.qty_remaining, b.qty_added, b.unit_cost_cents, b.sequence)
      is distinct from (s.qty_remaining, s.qty_added, s.unit_cost_cents, s.sequence);
  if v_diff <> 0 then raise exception 'H2(a): % of % legacy batches had quantities/costs changed', v_diff, v_n; end if;

  -- legacy rows must be classified 'legacy' and NOT claimed authoritative
  select count(*) into v_bad from public.sku_batches b join legacy_batch_snapshot s on s.id = b.id
    where b.cost_status <> 'legacy' or b.qty_added_authoritative;
  if v_bad <> 0 then raise exception 'H2(b): % legacy batches were falsely classified', v_bad; end if;

  select count(*) into v_diff from legacy_sku_snapshot s join public.inventory_skus i on i.id = s.id
   where (i.qty_on_hand, i.unit_cost_cents) is distinct from (s.qty_on_hand, s.unit_cost_cents);
  if v_diff <> 0 then raise exception 'H2(c): % SKU quantity/cost rows changed', v_diff; end if;

  raise notice '✓ H2: % legacy batches examined — unchanged, all cost_status=legacy, none authoritative', v_n;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════
-- TESTS A–L on NEW, post-migration data.
-- ════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A     uuid := '11111111-1111-1111-1111-111111111111';
  ORG1  uuid := '22222222-2222-2222-2222-222222222222';
  SESS  uuid;
  SK_A uuid; SK_B uuid; SK_C uuid; SK_D uuid; SK_I uuid; SK_J uuid; SK_L uuid; SK_E uuid; SK_F uuid; SK_NS uuid;
  BA uuid; BB uuid; BC uuid; BD1 uuid; BD2 uuid; BI uuid; BJ uuid;
  BL1 uuid; BL2 uuid; BL3 uuid; BE uuid; BF1 uuid; BF2 uuid; BNS uuid;
  v_src uuid; v_cost int; v_rem int; v_add int; v_auth boolean; v_status text;
  v_n int; v_qoh int; v_msg text; v_cnt int;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status) values (A, 'live') returning id into SESS;

  -- helper-ish: every SKU below is created with 0 on hand + no seed layer, then given
  -- explicit layers via lensed_add_batch so qty_added_authoritative is stamped by the RPC.

  -- ══ TEST A — normal FIFO attribution ═══════════════════════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 1, 'A', 'Test A', null, 0) returning id into SK_A;
  select public.lensed_add_batch(SK_A, 20, 300) into BA;

  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_A, 'qty', 1)), 'A-1', false, false);

  select b.qty_remaining into v_rem from public.sku_batches b where b.id = BA;
  if v_rem <> 19 then raise exception 'A: qty_remaining expected 19 got %', v_rem; end if;
  select las.unit_cost_cents_snapshot, las.source_batch_id into v_cost, v_src
    from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id
   where lai.client_idempotency_key = 'A-1';
  if v_cost <> 300 then raise exception 'A: snapshot expected 300 got %', v_cost; end if;
  if v_src is distinct from BA then raise exception 'A: source_batch_id expected % got %', BA, v_src; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SK_A;
  if v_qoh <> 19 then raise exception 'A: qty_on_hand expected 19 got %', v_qoh; end if;
  raise notice '✓ A: sale -> batch A, snapshot 300, qty 20->19, qty_on_hand in lockstep';

  -- ══ TEST B — pending (NULL-cost) batch still attributes ════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 2, 'B', 'Test B', null, 0) returning id into SK_B;
  select public.lensed_add_batch(SK_B, 100, null) into BB;

  select cost_status, unit_cost_cents into v_status, v_cost from public.sku_batches where id = BB;
  if v_status <> 'pending' or v_cost is not null then
    raise exception 'B: expected (pending, NULL) got (%, %)', v_status, v_cost; end if;

  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_B, 'qty', 1)), 'B-1', false, false);

  select las.unit_cost_cents_snapshot, las.source_batch_id into v_cost, v_src
    from public.live_auction_item_skus las join public.live_auction_items lai on lai.id = las.auction_item_id
   where lai.client_idempotency_key = 'B-1';
  -- snapshot behaviour is DELIBERATELY unchanged by this stage: a pending cost still
  -- snapshots NULL exactly as it did before 149. Only the attribution is new.
  if v_cost is not null then raise exception 'B: snapshot expected NULL (unchanged behaviour) got %', v_cost; end if;
  if v_src is distinct from BB then raise exception 'B: source_batch_id expected % got %', BB, v_src; end if;
  select qty_remaining into v_rem from public.sku_batches where id = BB;
  if v_rem <> 99 then raise exception 'B: qty_remaining expected 99 got %', v_rem; end if;
  raise notice '✓ B: pending layer -> snapshot still NULL, but the sale now names batch B';

  -- ══ TEST C — genuine free inventory stays FINAL and snapshots 0 ════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 3, 'C', 'Test C', null, 0) returning id into SK_C;
  select public.lensed_add_batch(SK_C, 100, 0) into BC;

  select cost_status into v_status from public.sku_batches where id = BC;
  if v_status <> 'final' then raise exception 'C: a genuine $0 must be final, got %', v_status; end if;

  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_C, 'qty', 1)), 'C-1', false, false);

  select las.unit_cost_cents_snapshot, las.source_batch_id into v_cost, v_src
    from public.live_auction_item_skus las join public.live_auction_items lai on lai.id = las.auction_item_id
   where lai.client_idempotency_key = 'C-1';
  if v_cost is distinct from 0 then raise exception 'C: snapshot expected 0 got %', v_cost; end if;
  if v_src is distinct from BC then raise exception 'C: source_batch_id expected % got %', BC, v_src; end if;
  select cost_status into v_status from public.sku_batches where id = BC;
  if v_status <> 'final' then raise exception 'C: cost_status drifted to %', v_status; end if;
  raise notice '✓ C: genuine $0 -> snapshot 0, attributed, still final (distinct from pending)';

  -- ══ TEST D — FIFO sequence: A,A,B ══════════════════════════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 4, 'D', 'Test D', null, 0) returning id into SK_D;
  select public.lensed_add_batch(SK_D, 2, 300) into BD1;
  select public.lensed_add_batch(SK_D, 2, 400) into BD2;

  perform * from public.lensed_log_auction(SESS, 'sold', jsonb_build_array(jsonb_build_object('sku_id', SK_D, 'qty', 1)), 'D-1', false, false);
  perform * from public.lensed_log_auction(SESS, 'sold', jsonb_build_array(jsonb_build_object('sku_id', SK_D, 'qty', 1)), 'D-2', false, false);
  perform * from public.lensed_log_auction(SESS, 'sold', jsonb_build_array(jsonb_build_object('sku_id', SK_D, 'qty', 1)), 'D-3', false, false);

  select las.source_batch_id into v_src from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'D-1';
  if v_src is distinct from BD1 then raise exception 'D: sale 1 expected batch 1 got %', v_src; end if;
  select las.source_batch_id, las.unit_cost_cents_snapshot into v_src, v_cost from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'D-2';
  if v_src is distinct from BD1 then raise exception 'D: sale 2 expected batch 1 got %', v_src; end if;
  if v_cost <> 300 then raise exception 'D: sale 2 cost expected 300 got %', v_cost; end if;
  select las.source_batch_id, las.unit_cost_cents_snapshot into v_src, v_cost from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'D-3';
  if v_src is distinct from BD2 then raise exception 'D: sale 3 expected batch 2 got %', v_src; end if;
  if v_cost <> 400 then raise exception 'D: sale 3 cost expected 400 got %', v_cost; end if;
  raise notice '✓ D: FIFO order proved by ID, not inferred from cost — A,A,B';

  -- ══ TEST I — original received quantity survives consumption ═══════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 9, 'I', 'Test I', null, 0) returning id into SK_I;
  select public.lensed_add_batch(SK_I, 500, null) into BI;
  select qty_added, qty_remaining, qty_added_authoritative into v_add, v_rem, v_auth
    from public.sku_batches where id = BI;
  if v_add <> 500 or v_rem <> 500 or not v_auth then
    raise exception 'I: at creation expected (500,500,true) got (%,%,%)', v_add, v_rem, v_auth; end if;

  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_I, 'qty', 120)), 'I-1', false, false);

  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BI;
  if v_add <> 500 then raise exception 'I: RECEIPT HISTORY LOST — qty_added became %', v_add; end if;
  if v_rem <> 380 then raise exception 'I: qty_remaining expected 380 got %', v_rem; end if;
  if (v_add - v_rem) <> 120 then raise exception 'I: derived consumed expected 120 got %', v_add - v_rem; end if;
  raise notice '✓ I: received 500 / remaining 380 / consumed 120 — qty_added untouched by consumption';

  -- ══ TEST J — a stock correction cannot silently redefine receipt history ═══════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 10, 'J', 'Test J', null, 0) returning id into SK_J;
  select public.lensed_add_batch(SK_J, 500, 340) into BJ;

  -- the supported quantity-edit path, on a still-UNTOUCHED post-cutover layer: this is the
  -- exact case where the pre-150 RPC re-based qty_added to the new number.
  perform public.lensed_edit_batch(SK_J, BJ, 450, 340, true);
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BJ;
  if v_add <> 500 then raise exception 'J: RECEIPT REWRITTEN — qty_added became % (must stay 500)', v_add; end if;
  if v_rem <> 450 then raise exception 'J: qty_remaining expected 450 got %', v_rem; end if;
  -- and the SKU total moved by exactly the delta, as before
  select qty_on_hand into v_qoh from public.inventory_skus where id = SK_J;
  if v_qoh <> 450 then raise exception 'J: qty_on_hand expected 450 got %', v_qoh; end if;
  raise notice '✓ J: stock 500->450 leaves Received=500 intact (pre-150 would have said 450)';

  -- J2: the legacy re-base behaviour is PRESERVED for legacy layers (no regression).
  declare LEG uuid; SK_LEG uuid; begin
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values (A, ORG1, 11, 'JL', 'Test J legacy', null, 0) returning id into SK_LEG;
    insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
      values (A, ORG1, SK_LEG, 100, 100, 500, 1) returning id into LEG;   -- authoritative defaults FALSE
    update public.inventory_skus set qty_on_hand = 100 where id = SK_LEG;
    perform public.lensed_edit_batch(SK_LEG, LEG, 90, 500, true);
    select qty_added into v_add from public.sku_batches where id = LEG;
    if v_add <> 90 then raise exception 'J2: legacy re-base REGRESSED — qty_added % (expected 90)', v_add; end if;
    raise notice '✓ J2: legacy layers keep the pre-150 re-base behaviour exactly';
  end;

  -- ══ TEST K — the raw fields the app layer derives Received/Remaining/Consumed from ══
  select qty_added, qty_remaining, qty_added_authoritative into v_add, v_rem, v_auth
    from public.sku_batches where id = BI;
  if v_add is null or not v_auth then raise exception 'K: batch BI cannot support derivation'; end if;
  if (v_add, v_rem, v_add - v_rem) is distinct from (500, 380, 120) then
    raise exception 'K: expected (500,380,120) got (%,%,%)', v_add, v_rem, v_add - v_rem; end if;
  -- no redundant stored "consumed" column was introduced
  select count(*) into v_cnt from information_schema.columns
   where table_schema='public' and table_name='sku_batches';
  if v_cnt = 0 then raise exception 'K: VACUOUS — no columns found on sku_batches'; end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='sku_batches'
                and column_name in ('consumed_qty','qty_consumed','consumed')) then
    raise exception 'K: a redundant stored consumed column was added';
  end if;
  raise notice '✓ K: (500,380) exposed raw; consumed is DERIVED — % columns examined, none named consumed', v_cnt;

  -- ══ TEST L — batches report independently ═════════════════════════════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 12, 'L', 'Test L', null, 0) returning id into SK_L;
  select public.lensed_add_batch(SK_L, 500, 100) into BL1;
  select public.lensed_add_batch(SK_L, 600, 200) into BL2;
  select public.lensed_add_batch(SK_L, 400, 300) into BL3;
  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_L, 'qty', 500)), 'L-1', false, false);  -- drains BL1
  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_L, 'qty', 175)), 'L-2', false, false);  -- 175 from BL2

  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BL1;
  if (v_add, v_rem, v_add - v_rem) is distinct from (500, 0, 500) then
    raise exception 'L: batch1 expected 500/0/500 got %/%/%', v_add, v_rem, v_add - v_rem; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BL2;
  if (v_add, v_rem, v_add - v_rem) is distinct from (600, 425, 175) then
    raise exception 'L: batch2 expected 600/425/175 got %/%/%', v_add, v_rem, v_add - v_rem; end if;
  select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BL3;
  if (v_add, v_rem, v_add - v_rem) is distinct from (400, 400, 0) then
    raise exception 'L: batch3 expected 400/400/0 got %/%/%', v_add, v_rem, v_add - v_rem; end if;
  -- and each sale names the right layer
  select las.source_batch_id into v_src from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'L-1';
  if v_src is distinct from BL1 then raise exception 'L: L-1 should name batch1'; end if;
  select las.source_batch_id into v_src from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'L-2';
  if v_src is distinct from BL2 then raise exception 'L: L-2 should name batch2'; end if;
  raise notice '✓ L: 500/0/500 · 600/425/175 · 400/400/0 — independent, no cross-inference';

  -- ══ TEST E — a CONSUMED layer cannot be deleted, so provenance cannot be erased ════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 5, 'E', 'Test E', null, 0) returning id into SK_E;
  select public.lensed_add_batch(SK_E, 10, 700) into BE;
  select public.lensed_add_batch(SK_E, 5, 800) into BF2;   -- second layer so E is not "last"
  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_E, 'qty', 4)), 'E-1', false, false);

  -- First: the existing guard rejects it, because qty_remaining (6) <> qty_added (10).
  begin
    perform public.lensed_delete_batch(SK_E, BE);
    raise exception 'E: delete of a consumed layer unexpectedly SUCCEEDED (guard)';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_DELETABLE' in v_msg) = 0 then raise exception 'E: wrong error: %', v_msg; end if;
  end;

  -- Now DEFEAT that guard exactly as the audit showed is possible: edit qty_remaining back
  -- up to equal qty_added, which makes a drawn-from layer look untouched again. Before 149
  -- this is the point at which the layer — and its sales' provenance — could be deleted.
  perform public.lensed_edit_batch(SK_E, BE, 10, 700, true);
  select qty_remaining, qty_added into v_rem, v_add from public.sku_batches where id = BE;
  if v_rem <> v_add then raise exception 'E: setup failed, guard not defeated (%,%)', v_rem, v_add; end if;

  begin
    perform public.lensed_delete_batch(SK_E, BE);
    raise exception 'E: CONSUMED LAYER WAS DELETED — attribution destroyed';
  exception when foreign_key_violation then
    null;  -- the FK is the real backstop, and it held
  when others then
    get stacked diagnostics v_msg = message_text;
    if position('BATCH_NOT_DELETABLE' in v_msg) = 0 and position('foreign key' in lower(v_msg)) = 0 then
      raise exception 'E: unexpected error: %', v_msg; end if;
  end;

  -- the sale still points at the original layer, and quantities are untouched by the failure
  select count(*) into v_n from public.sku_batches where id = BE;
  if v_n <> 1 then raise exception 'E: batch row disappeared'; end if;
  select las.source_batch_id into v_src from public.live_auction_item_skus las
    join public.live_auction_items lai on lai.id = las.auction_item_id where lai.client_idempotency_key = 'E-1';
  if v_src is distinct from BE then raise exception 'E: provenance lost, source_batch_id = %', v_src; end if;
  raise notice '✓ E: even with the untouched-guard defeated, the FK refuses the delete and provenance survives';

  -- ══ TEST F — an UNTOUCHED layer is still deletable (no regression) ════════════════
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 6, 'F', 'Test F', null, 0) returning id into SK_F;
  select public.lensed_add_batch(SK_F, 7, 900) into BF1;
  select public.lensed_add_batch(SK_F, 3, 950) into BNS;  -- a 2nd layer so BF1 is not the last
  select qty_on_hand into v_qoh from public.inventory_skus where id = SK_F;
  if v_qoh <> 10 then raise exception 'F: setup qty_on_hand expected 10 got %', v_qoh; end if;

  perform public.lensed_delete_batch(SK_F, BF1);
  select count(*) into v_n from public.sku_batches where id = BF1;
  if v_n <> 0 then raise exception 'F: untouched layer was NOT deleted — regression from the new FK'; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id = SK_F;
  if v_qoh <> 3 then raise exception 'F: qty_on_hand expected 3 got %', v_qoh; end if;
  raise notice '✓ F: untouched layer still deletes cleanly, qty_on_hand 10->3 — no FK regression';

  -- ══ EXTRA 1 — a not_sold line draws nothing and must NOT inherit a batch id ════════
  -- Guards the loop-variable hazard: v_batch is a record that outlives an iteration.
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 7, 'NS', 'Test not_sold', 111, 0) returning id into SK_NS;
  select public.lensed_add_batch(SK_NS, 5, 111) into BNS;
  perform * from public.lensed_log_auction(SESS, 'not_sold',
    jsonb_build_array(jsonb_build_object('sku_id', SK_NS, 'qty', 1)), 'NS-1', false, false);
  select las.source_batch_id, las.unit_cost_cents_snapshot into v_src, v_cost
    from public.live_auction_item_skus las join public.live_auction_items lai on lai.id = las.auction_item_id
   where lai.client_idempotency_key = 'NS-1';
  if v_src is not null then raise exception 'EXTRA1: not_sold line fabricated source_batch_id %', v_src; end if;
  if v_cost <> 111 then raise exception 'EXTRA1: not_sold provisional cost changed, got %', v_cost; end if;
  select qty_remaining into v_rem from public.sku_batches where id = BNS;
  if v_rem <> 5 then raise exception 'EXTRA1: not_sold drew stock! qty_remaining %', v_rem; end if;
  raise notice '✓ EXTRA1: not_sold draws nothing, attributes nothing, keeps its provisional cost';

  -- ══ EXTRA 2 — mixed bundle: sold line attributed, and a not_sold sibling is impossible
  --    (p_result is per CALL) — so instead prove a MULTI-SKU sold bundle attributes each
  --    line to its own layer.
  declare SK_X uuid; SK_Y uuid; B_X uuid; B_Y uuid; v_sx uuid; v_sy uuid; begin
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values (A, ORG1, 20, 'X', 'Bundle X', null, 0) returning id into SK_X;
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values (A, ORG1, 21, 'Y', 'Bundle Y', null, 0) returning id into SK_Y;
    select public.lensed_add_batch(SK_X, 5, 1000) into B_X;
    select public.lensed_add_batch(SK_Y, 5, 2000) into B_Y;
    perform * from public.lensed_log_auction(SESS, 'sold',
      jsonb_build_array(jsonb_build_object('sku_id', SK_X, 'qty', 1),
                        jsonb_build_object('sku_id', SK_Y, 'qty', 2)), 'XY-1', false, false);
    select las.source_batch_id into v_sx from public.live_auction_item_skus las
      join public.live_auction_items lai on lai.id = las.auction_item_id
     where lai.client_idempotency_key = 'XY-1' and las.inventory_sku_id = SK_X;
    select las.source_batch_id into v_sy from public.live_auction_item_skus las
      join public.live_auction_items lai on lai.id = las.auction_item_id
     where lai.client_idempotency_key = 'XY-1' and las.inventory_sku_id = SK_Y;
    if v_sx is distinct from B_X or v_sy is distinct from B_Y then
      raise exception 'EXTRA2: bundle lines mis-attributed (x=%, y=%)', v_sx, v_sy; end if;
    if (select qty_remaining from public.sku_batches where id = B_Y) <> 3 then
      raise exception 'EXTRA2: qty-2 line did not draw 2'; end if;
    raise notice '✓ EXTRA2: each bundle line names its own layer';
  end;

  -- ══ EXTRA 3 — oversell attributes the NEGATIVE layer it actually drew ══════════════
  declare SK_O uuid; BO1 uuid; BO2 uuid; begin
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values (A, ORG1, 30, 'O', 'Oversell', null, 0) returning id into SK_O;
    select public.lensed_add_batch(SK_O, 1, 100) into BO1;
    select public.lensed_add_batch(SK_O, 2, 200) into BO2;   -- newest layer takes the hit
    perform * from public.lensed_log_auction(SESS, 'sold',
      jsonb_build_array(jsonb_build_object('sku_id', SK_O, 'qty', 5)), 'O-1', true, true);
    select las.source_batch_id, las.short_at_bind into v_src, v_auth
      from public.live_auction_item_skus las join public.live_auction_items lai on lai.id = las.auction_item_id
     where lai.client_idempotency_key = 'O-1';
    if v_src is distinct from BO2 then raise exception 'EXTRA3: oversell must name the NEWEST layer, got %', v_src; end if;
    if not v_auth then raise exception 'EXTRA3: short_at_bind must stay true'; end if;
    if (select qty_remaining from public.sku_batches where id = BO2) <> -3 then
      raise exception 'EXTRA3: newest layer should be -3'; end if;

    -- ══ EXTRA 4 — settling that deficit keeps Consumed truthful ════════════════════
    perform public.lensed_settle_batch(BO2);
    select qty_added, qty_remaining into v_add, v_rem from public.sku_batches where id = BO2;
    if v_rem <> 0 then raise exception 'EXTRA4: settle should reach 0, got %', v_rem; end if;
    if v_add <> 5 then raise exception 'EXTRA4: receipt total should grow 2->5, got %', v_add; end if;
    if (v_add - v_rem) <> 5 then raise exception 'EXTRA4: derived consumed should stay 5, got %', v_add - v_rem; end if;
    raise notice '✓ EXTRA3/4: oversell names the negative layer; settle keeps Received 5 / Consumed 5 truthful';
  end;

  -- ══ EXTRA 5 — cost_status transitions, and the CHECK that makes them total ════════
  declare SK_T uuid; BT uuid; begin
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values (A, ORG1, 40, 'T', 'Transitions', null, 0) returning id into SK_T;
    select public.lensed_add_batch(SK_T, 10, null) into BT;
    if (select cost_status from public.sku_batches where id = BT) <> 'pending' then
      raise exception 'EXTRA5: new blank-cost layer must be pending'; end if;

    perform public.lensed_edit_batch(SK_T, BT, 10, 425, true);
    if (select cost_status from public.sku_batches where id = BT) <> 'final' then
      raise exception 'EXTRA5: entering a cost must move pending -> final'; end if;

    perform public.lensed_edit_batch(SK_T, BT, 10, null, true);
    if (select cost_status from public.sku_batches where id = BT) <> 'pending' then
      raise exception 'EXTRA5: blanking a cost must move final -> pending'; end if;

    -- a qty-only edit (p_set_cost false) must leave BOTH cost and state alone
    perform public.lensed_edit_batch(SK_T, BT, 9, null, false);
    if (select cost_status from public.sku_batches where id = BT) <> 'pending'
       or (select unit_cost_cents from public.sku_batches where id = BT) is not null then
      raise exception 'EXTRA5: qty-only edit disturbed cost state'; end if;

    -- and the CHECK really can fail (proving it is not vacuous)
    begin
      update public.sku_batches set cost_status = 'final' where id = BT;   -- cost is NULL
      raise exception 'EXTRA5: sku_batches_cost_status_chk did NOT reject (final, NULL)';
    exception when check_violation then null;
    end;
    raise notice '✓ EXTRA5: pending<->final transitions work; CHECK proven able to fail';
  end;

  raise notice '── all in-SQL assertions passed ──';
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════
-- Catalog assertions: the migration is ADDITIVE and the objects are shaped as intended.
-- Positive assertions wherever possible (CONVENTIONS.md rule 3).
-- ════════════════════════════════════════════════════════════════════════════════════
do $$
declare v_rule text; v_cnt int;
begin
  select rc.delete_rule into v_rule
    from information_schema.referential_constraints rc
   where rc.constraint_name = 'live_auction_item_skus_source_batch_id_fkey';
  if v_rule is null then raise exception 'CATALOG: the source_batch_id FK does not exist'; end if;
  if v_rule <> 'NO ACTION' then raise exception 'CATALOG: FK delete_rule is % (expected NO ACTION — SET NULL would erase provenance)', v_rule; end if;

  select count(*) into v_cnt from pg_indexes
   where schemaname='public' and tablename='live_auction_item_skus'
     and indexname='idx_live_auction_item_skus_source_batch';
  if v_cnt <> 1 then raise exception 'CATALOG: batch->sale index missing'; end if;

  select count(*) into v_cnt from pg_constraint
   where conrelid='public.sku_batches'::regclass
     and conname in ('sku_batches_cost_status_chk','sku_batches_qty_added_authoritative_chk');
  if v_cnt <> 2 then raise exception 'CATALOG: expected 2 new CHECKs, found %', v_cnt; end if;

  -- signatures must be byte-identical to pre-150 (no accidental API break)
  if pg_get_function_identity_arguments('public.lensed_log_auction'::regproc)
     <> 'p_session_id uuid, p_result text, p_skus jsonb, p_idem_key text, p_manual boolean, p_allow_negative boolean' then
    raise exception 'CATALOG: lensed_log_auction signature changed';
  end if;
  if pg_get_function_identity_arguments('public.lensed_edit_batch'::regproc)
     <> 'p_sku_id uuid, p_batch_id uuid, p_qty_remaining integer, p_unit_cost_cents integer, p_set_cost boolean' then
    raise exception 'CATALOG: lensed_edit_batch signature changed';
  end if;
  raise notice '✓ CATALOG: FK=NO ACTION, index present, 2 CHECKs, RPC signatures unchanged';
end $$;
