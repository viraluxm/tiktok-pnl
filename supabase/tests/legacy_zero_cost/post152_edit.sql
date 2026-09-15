-- The window migration 155 GROUP 2 exists to close: 152/153/154 are live, and a user prices a
-- legacy $0 layer through the ordinary inline editor before the reconciliation has run.
-- lensed_edit_batch sets a positive cost and flips cost_status to 'final' — but it reprices no
-- history, so the layer's past sales stay stranded at $0 and it falls out of GROUP 1.
do $$
declare
  A uuid := '11111111-1111-1111-1111-111111111111';
  s uuid; b uuid; ln uuid;
begin
  perform set_config('test.user_id', A::text, false);

  -- CASE D: price the whole layer at $1.25.
  select id into s from public.inventory_skus where barcode = 'LZ-D';
  select id into b from public.sku_batches where sku_id = s;
  perform * from public.lensed_edit_batch(s, b, 160, 125, true);

  -- CASE E: one line was drawn while the layer really held $0.90 (a pre-153 draw, so it carries
  -- no source_batch_id), then the layer is priced at $1.25.
  select id into s from public.inventory_skus where barcode = 'LZ-E';
  select id into b from public.sku_batches where sku_id = s;
  select l.id into ln from public.live_auction_item_skus l
    join public.live_auction_items i on i.id = l.auction_item_id
   where l.inventory_sku_id = s and i.status = 'sold' order by l.created_at limit 1;
  update public.live_auction_item_skus set unit_cost_cents_snapshot = 90 where id = ln;
  perform * from public.lensed_edit_batch(s, b, 90, 125, true);

  -- CASE F — a GENUINE post-152 finalized $0 cost. Out of scope: authoritative = true.
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,'22222222-2222-2222-2222-222222222222',908,'LZ-F','Case F real $0 final',0,30) returning id into s;
  insert into public.sku_batches
    (user_id,org_id,sku_id,qty_remaining,qty_added,qty_added_authoritative,unit_cost_cents,cost_status,sequence)
    values (A,'22222222-2222-2222-2222-222222222222',s,30,30,true,0,'final',1);

  -- CASE I — 'final' + authoritative=false but created AFTER the cutoff. Out of scope: the
  -- cutoff is what proves the row's cost_status started life as 152's 'legacy' default.
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A,'22222222-2222-2222-2222-222222222222',909,'LZ-I','Case I after cutoff',300,20) returning id into s;
  insert into public.sku_batches
    (user_id,org_id,sku_id,qty_remaining,qty_added,qty_added_authoritative,unit_cost_cents,cost_status,sequence,created_at)
    values (A,'22222222-2222-2222-2222-222222222222',s,20,20,false,300,'final',1,'2030-01-01T00:00:00Z');

  raise notice '✓ post-152 inline edits applied (the GROUP 2 window)';
end $$;
