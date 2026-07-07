-- Multiple separate live sessions in the same day must NOT be merged by the fix.
-- The per-user idempotency only replays an EXACT repeat order_id; every new order_id
-- still inserts into the passed session with that session's next sequence.
-- Runs AFTER 043. Uses its own SKU + sessions (isolated from test_forward.sql).
select set_config('test.user_id', '11111111-1111-1111-1111-111111111111', false);

insert into public.inventory_skus (id, user_id, org_id, sku_number, title, unit_cost_cents, qty_on_hand)
values ('0af00000-0000-0000-0000-0000000000c1',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        401,'Multi-Live SKU',500,10);
insert into public.sku_batches (id, user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence)
values ('0bf00000-0000-0000-0000-0000000000c1',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        '0af00000-0000-0000-0000-0000000000c1',10,500,1);
insert into public.live_sessions (id, user_id, status, source) values
 ('0ca00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','live','extension'),  -- Live A
 ('0cb00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','live','extension');  -- Live B

do $$
declare
  v_a1 int; v_a2 int; v_b1 int; v_b2 int; v_b3 int; v_rep boolean;
  v_sess uuid; v_rows int; v_qoh int;
  c_sku constant text := '[{"sku_id":"0af00000-0000-0000-0000-0000000000c1","qty":1}]';
  c_A constant uuid := '0ca00000-0000-0000-0000-000000000001';
  c_B constant uuid := '0cb00000-0000-0000-0000-000000000001';
begin
  -- (1) Live A: two distinct orders → session A, sequences 1 and 2
  select auction_number into v_a1 from public.lensed_log_auction(c_A,'sold',c_sku::jsonb,'A-ORD1');
  select auction_number into v_a2 from public.lensed_log_auction(c_A,'sold',c_sku::jsonb,'A-ORD2');
  if v_a1 <> 1 or v_a2 <> 2 then raise exception 'FAIL m1: Live A sequences % , % (want 1,2)', v_a1, v_a2; end if;
  perform 1 from public.live_auction_items where client_idempotency_key in ('A-ORD1','A-ORD2') and session_id <> c_A;
  if found then raise exception 'FAIL m1: a Live A order landed outside session A'; end if;

  -- (2) Live B: two NEW distinct orders → session B, sequences 1 and 2 (independent of A)
  select auction_number into v_b1 from public.lensed_log_auction(c_B,'sold',c_sku::jsonb,'B-ORD1');
  select auction_number into v_b2 from public.lensed_log_auction(c_B,'sold',c_sku::jsonb,'B-ORD2');
  if v_b1 <> 1 or v_b2 <> 2 then raise exception 'FAIL m2: Live B sequences % , % (want 1,2)', v_b1, v_b2; end if;
  perform 1 from public.live_auction_items where client_idempotency_key in ('B-ORD1','B-ORD2') and session_id <> c_B;
  if found then raise exception 'FAIL m2: a Live B order landed outside session B'; end if;

  -- (3) Re-submit an OLD Live A order while the extension is now on session B →
  --     replay the canonical Live A row; NO new row; does not attach to B.
  select replayed, auction_number into v_rep, v_a1 from public.lensed_log_auction(c_B,'sold',c_sku::jsonb,'A-ORD1');
  if not v_rep then raise exception 'FAIL m3: old order re-submit should replay, got new insert'; end if;
  select count(*) into v_rows from public.live_auction_items where client_idempotency_key='A-ORD1';
  if v_rows <> 1 then raise exception 'FAIL m3: A-ORD1 now has % rows (want 1)', v_rows; end if;
  select session_id into v_sess from public.live_auction_items where client_idempotency_key='A-ORD1';
  if v_sess <> c_A then raise exception 'FAIL m3: A-ORD1 canonical row moved off session A'; end if;
  if v_a1 <> 1 then raise exception 'FAIL m3: replay returned sequence % (want original 1)', v_a1; end if;
  select count(*) into v_rows from public.live_auction_items where session_id = c_B;
  if v_rows <> 2 then raise exception 'FAIL m3: session B gained a row from the replay (has %, want 2)', v_rows; end if;

  -- (4) A brand-new order in session B after the replay → next B sequence (3)
  select auction_number into v_b3 from public.lensed_log_auction(c_B,'sold',c_sku::jsonb,'B-ORD3');
  if v_b3 <> 3 then raise exception 'FAIL m4: new Live B order sequence % (want 3)', v_b3; end if;
  select session_id into v_sess from public.live_auction_items where client_idempotency_key='B-ORD3';
  if v_sess <> c_B then raise exception 'FAIL m4: B-ORD3 not in session B'; end if;

  -- Inventory: 5 distinct sold orders drew once each (A1,A2,B1,B2,B3); the replay drew nothing.
  select qty_on_hand into v_qoh from public.inventory_skus where id='0af00000-0000-0000-0000-0000000000c1';
  if v_qoh <> 5 then raise exception 'FAIL m: qty_on_hand % (want 5 = 10 - 5 draws)', v_qoh; end if;

  raise notice 'PASS multi-live: separate lives keep independent sequences; only exact repeat order_id replays';
end $$;
