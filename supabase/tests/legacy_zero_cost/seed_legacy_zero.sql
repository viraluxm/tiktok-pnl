-- The PRE-152 world for migration 155's tests: legacy $0 layers whose sales were bound by the
-- OLD lensed_log_auction (so they carry no source_batch_id), created before 152/153/154 exist.
do $$
declare
  A uuid := '11111111-1111-1111-1111-111111111111';
  ORG1 uuid := '22222222-2222-2222-2222-222222222222';
  SESS uuid; s uuid; b uuid; b2 uuid; b3 uuid; i int;
begin
  perform set_config('test.user_id', A::text, false);
  insert into public.live_sessions (user_id, status, title, started_at)
    values (A,'live','legacy seed', now() - interval '10 days') returning id into SESS;

  -- ══ CASE A — single legacy $0 layer, 500 added, 120 sold as qty-1 lines ══
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,901,'LZ-A','Case A single $0',0,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,500,500,0,1, now() - interval '9 days') returning id into b;
  update public.inventory_skus set qty_on_hand = 500 where id = s;
  for i in 1..120 loop
    perform * from public.lensed_log_auction(SESS,'sold',
      jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'A-'||i, true, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values (A,'A-'||i, 1000, now() - interval '8 days');
  end loop;
  -- a not_sold line: creates a sale row but draws NO stock. The reconciliation must ignore it.
  perform * from public.lensed_log_auction(SESS,'not_sold',
    jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'A-ns', true, false);

  -- ══ CASE B/C — three layers: A $3 (100), B $0 legacy (200), C $5 (100) ══
  -- Case C's whole-line rule is exercised by a qty-150 line: layer A (100 left) cannot cover
  -- it and must be SKIPPED rather than split.
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,902,'LZ-B','Case B multi-layer',300,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,100,100,300,1, now() - interval '9 days') returning id into b;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,200,200,0,2, now() - interval '9 days') returning id into b2;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,100,100,500,3, now() - interval '9 days') returning id into b3;
  update public.inventory_skus set qty_on_hand = 400 where id = s;
  -- 60 from A (qty-1 x60), then a qty-150 line that SKIPS A (only 40 left) and takes B
  for i in 1..60 loop
    perform * from public.lensed_log_auction(SESS,'sold',
      jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'B-'||i, true, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values (A,'B-'||i, 1000, now() - interval '8 days');
  end loop;
  perform * from public.lensed_log_auction(SESS,'sold',
    jsonb_build_array(jsonb_build_object('sku_id',s,'qty',150)), 'B-big', true, false);
  insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
    values (A,'B-big', 90000, now() - interval '7 days');

  -- ══ CASE G — intentionally unrecoverable: a sibling layer with qty_added NULL ══
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,903,'LZ-G','Case G ambiguous',0,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,50,null,120,1, now() - interval '9 days') returning id into b;   -- qty_added NULL
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,0,0,0,2, now() - interval '9 days') returning id into b2;        -- the $0 layer
  update public.inventory_skus set qty_on_hand = 50 where id = s;
  for i in 1..5 loop
    perform * from public.lensed_log_auction(SESS,'sold',
      jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'G-'||i, true, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values (A,'G-'||i, 1000, now() - interval '8 days');
  end loop;

  -- ══ CASE H — a legacy layer with a POSITIVE cost, and one with NULL: both out of scope ══
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,904,'LZ-H','Case H out of scope',250,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,40,40,250,1, now() - interval '9 days');
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,905,'LZ-H2','Case H null cost',null,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,40,40,null,1, now() - interval '9 days');
  update public.inventory_skus set qty_on_hand = 40 where barcode in ('LZ-H','LZ-H2');

  -- ══ CASE D — legacy $0 layer that WILL be edited to a positive cost after 152 (GROUP 2) ══
  -- 200 added, 40 sold at $0 snapshot. post152_edit.sql then prices it at $1.25 through
  -- lensed_edit_batch, exactly as the inline editor does, producing ('final', authoritative=false).
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,906,'LZ-D','Case D edited-to-final',0,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,200,200,0,1, now() - interval '9 days') returning id into b;
  update public.inventory_skus set qty_on_hand = 200 where id = s;
  for i in 1..40 loop
    perform * from public.lensed_log_auction(SESS,'sold',
      jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'D-'||i, true, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values (A,'D-'||i, 1000, now() - interval '8 days');
  end loop;

  -- ══ CASE E — same as D, but one sale was drawn while the layer genuinely held a cost ══
  -- post152_edit.sql marks one line's snapshot non-zero before pricing the layer. That line must
  -- be ATTRIBUTED but NOT repriced: its snapshot is real history, not a $0 placeholder.
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,ORG1,907,'LZ-E','Case E mixed snapshots',0,0) returning id into s;
  insert into public.sku_batches (user_id,org_id,sku_id,qty_remaining,qty_added,unit_cost_cents,sequence,created_at)
    values (A,ORG1,s,100,100,0,1, now() - interval '9 days') returning id into b;
  update public.inventory_skus set qty_on_hand = 100 where id = s;
  for i in 1..10 loop
    perform * from public.lensed_log_auction(SESS,'sold',
      jsonb_build_array(jsonb_build_object('sku_id',s,'qty',1)), 'E-'||i, true, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values (A,'E-'||i, 1000, now() - interval '8 days');
  end loop;

  raise notice '✓ pre-152 legacy world seeded';
end $$;
