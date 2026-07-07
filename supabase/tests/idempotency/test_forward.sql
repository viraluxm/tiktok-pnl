-- Forward-behavior tests: run AFTER 043 is applied (new function + per-user index).
-- Proves the bug is fixed AND normal flows are intact. Fresh SKU/sessions so this
-- does not interfere with the repair seed. Fixed test user + org from bootstrap.sql.
select set_config('test.user_id', '11111111-1111-1111-1111-111111111111', false);

insert into public.inventory_skus (id, user_id, org_id, sku_number, title, unit_cost_cents, qty_on_hand)
values ('0af00000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        201,'Fwd SKU',500,10);
insert into public.sku_batches (id, user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence)
values ('0bf00000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        '0af00000-0000-0000-0000-000000000001',10,500,1);
insert into public.live_sessions (id, user_id, status, source) values
 ('0cf00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','live','extension'),
 ('0cf00000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','live','extension');

-- ── Scenario 1: one normal new sold order → exactly one row, sequence 1, one SKU line, one draw ──
do $$
declare v_seq int; v_replayed boolean; v_qoh int; v_lines int;
begin
  select auction_number, replayed into v_seq, v_replayed
    from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
      '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O1');
  if v_seq <> 1 or v_replayed then raise exception 'FAIL s1: seq=% replayed=% (want 1,false)', v_seq, v_replayed; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_qoh <> 9 then raise exception 'FAIL s1: qty_on_hand % want 9', v_qoh; end if;
  select count(*) into v_lines from public.live_auction_item_skus s
    join public.live_auction_items i on i.id=s.auction_item_id where i.client_idempotency_key='O1';
  if v_lines <> 1 then raise exception 'FAIL s1(=s5 SKU-bind): expected 1 SKU line, got %', v_lines; end if;
  raise notice 'PASS s1/s5: new sold order → 1 row seq1, 1 SKU line bound, 1 draw';
end $$;

-- ── Scenario 2: multiple DISTINCT orders in one session → sequences increment ──
do $$
declare v_seq2 int; v_seq3 int;
begin
  select auction_number into v_seq2 from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O2');
  select auction_number into v_seq3 from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O3');
  if v_seq2 <> 2 or v_seq3 <> 3 then raise exception 'FAIL s2: sequences % , % (want 2,3)', v_seq2, v_seq3; end if;
  raise notice 'PASS s2: distinct orders increment sequence 2,3';
end $$;

-- ── Scenario 3: same order ×6 in the SAME session → one row, one draw ──
do $$
declare i int; v_seq int; v_rows int; v_qoh_before int; v_qoh_after int;
begin
  select qty_on_hand into v_qoh_before from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  for i in 1..6 loop
    select auction_number into v_seq from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
      '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_SIX');
  end loop;
  select count(*) into v_rows from public.live_auction_items where client_idempotency_key='O_SIX';
  select qty_on_hand into v_qoh_after from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_rows <> 1 then raise exception 'FAIL s3: expected 1 row for O_SIX, got %', v_rows; end if;
  if (v_qoh_before - v_qoh_after) <> 1 then raise exception 'FAIL s3: drew % units, want 1', v_qoh_before - v_qoh_after; end if;
  raise notice 'PASS s3: same order x6 → 1 row, 1 draw (seq %)', v_seq;
end $$;

-- ── Scenario 4: same order from TWO different sessions → one row, one draw ──
do $$
declare v_rep1 boolean; v_rep2 boolean; v_rows int; v_sess uuid; v_qoh_before int; v_qoh_after int;
begin
  select qty_on_hand into v_qoh_before from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  select replayed into v_rep1 from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_CROSS');
  select replayed into v_rep2 from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000002','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_CROSS');
  select count(*) into v_rows from public.live_auction_items where client_idempotency_key='O_CROSS';
  select session_id into v_sess from public.live_auction_items where client_idempotency_key='O_CROSS' limit 1;
  select qty_on_hand into v_qoh_after from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_rep1 then raise exception 'FAIL s4: first call should be a new insert'; end if;
  if not v_rep2 then raise exception 'FAIL s4: second (other-session) call should replay'; end if;
  if v_rows <> 1 then raise exception 'FAIL s4: expected 1 row total for O_CROSS, got %', v_rows; end if;
  if v_sess <> '0cf00000-0000-0000-0000-000000000001' then raise exception 'FAIL s4: row not in the first session'; end if;
  if (v_qoh_before - v_qoh_after) <> 1 then raise exception 'FAIL s4: drew % units, want 1', v_qoh_before - v_qoh_after; end if;
  raise notice 'PASS s4: same order, two sessions → 1 row, 1 draw';
end $$;

-- ── Scenario 6: sold WITHOUT SKUs → raises NO_SKUS (unchanged) ──
do $$
begin
  perform * from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold','[]'::jsonb,'O_NOSKU');
  raise exception 'FAIL s6: expected NO_SKUS, call succeeded';
exception
  when others then
    if sqlerrm not like '%NO_SKUS%' then raise exception 'FAIL s6: expected NO_SKUS, got %', sqlerrm; end if;
    raise notice 'PASS s6: sold without SKUs → NO_SKUS (unchanged)';
end $$;

-- ── Scenario 7: not_sold → sold transition → single draw, then replay (no double draw) ──
do $$
declare v_qoh0 int; v_qoh1 int; v_qoh2 int; v_qoh3 int; v_status text; v_rep boolean; v_rows int;
begin
  select qty_on_hand into v_qoh0 from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  -- (a) not_sold: creates the row, NO draw
  perform * from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','not_sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_TRANS');
  select qty_on_hand into v_qoh1 from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_qoh1 <> v_qoh0 then raise exception 'FAIL s7a: not_sold drew inventory (% -> %)', v_qoh0, v_qoh1; end if;
  -- (b) sold: flips + draws exactly once
  select status, replayed into v_status, v_rep from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_TRANS');
  select qty_on_hand into v_qoh2 from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_status <> 'sold' or v_rep then raise exception 'FAIL s7b: status=% replayed=% (want sold,false)', v_status, v_rep; end if;
  if (v_qoh1 - v_qoh2) <> 1 then raise exception 'FAIL s7b: transition drew % (want 1)', v_qoh1 - v_qoh2; end if;
  -- (c) sold again: replay, NO second draw
  perform * from public.lensed_log_auction('0cf00000-0000-0000-0000-000000000001','sold',
    '[{"sku_id":"0af00000-0000-0000-0000-000000000001","qty":1}]'::jsonb,'O_TRANS');
  select qty_on_hand into v_qoh3 from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  if v_qoh3 <> v_qoh2 then raise exception 'FAIL s7c: repeat sold drew again (% -> %)', v_qoh2, v_qoh3; end if;
  select count(*) into v_rows from public.live_auction_items where client_idempotency_key='O_TRANS';
  if v_rows <> 1 then raise exception 'FAIL s7: expected 1 row for O_TRANS, got %', v_rows; end if;
  raise notice 'PASS s7: not_sold->sold transition draws once, no double draw';
end $$;

-- ── Final invariant: total draws on Fwd SKU = 6 (O1,O2,O3,O_SIX,O_CROSS,O_TRANS) ──
do $$
declare v_qoh int; v_batch int;
begin
  select qty_on_hand into v_qoh from public.inventory_skus where id='0af00000-0000-0000-0000-000000000001';
  select qty_remaining into v_batch from public.sku_batches where id='0bf00000-0000-0000-0000-000000000001';
  if v_qoh <> 4 then raise exception 'FAIL final: qty_on_hand % want 4 (10 - 6 draws)', v_qoh; end if;
  if v_batch <> 4 then raise exception 'FAIL final: batch qty_remaining % want 4', v_batch; end if;
  if v_qoh <> v_batch then raise exception 'FAIL final: qty_on_hand/batch invariant broken % <> %', v_qoh, v_batch; end if;
  raise notice 'PASS final: qty_on_hand=4=Σbatch (6 draws, FIFO invariant holds)';
end $$;
