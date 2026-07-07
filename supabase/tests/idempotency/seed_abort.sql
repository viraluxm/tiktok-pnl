-- Ambiguous-repair case: duplicate for 'ORDER-AMB' where the SKU has TWO batches
-- with the SAME unit_cost as the drawn snapshot → the repair cannot be CERTAIN which
-- batch to credit back, so 043 must abort with DEDUP_NEEDS_MANUAL_REVIEW and change
-- nothing (whole migration rolls back).
insert into public.inventory_skus (id, user_id, org_id, sku_number, title, unit_cost_cents, qty_on_hand)
values ('0a000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        301,'Ambiguous SKU',500,8);
insert into public.sku_batches (id, user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence) values
 ('0b000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
  '0a000000-0000-0000-0000-0000000000a1',3,500,1),
 ('0b000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
  '0a000000-0000-0000-0000-0000000000a1',5,500,2);

insert into public.live_sessions (id, user_id, status, source) values
 ('0c000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','live','extension'),
 ('0c000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','live','extension');
insert into public.live_auction_items
  (id, user_id, session_id, sequence, status, expected_price_cents, client_idempotency_key, created_at) values
 ('0d000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-0000000000a1',1,'sold',1500,'ORDER-AMB', now() - interval '10 minutes'),
 ('0d000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-0000000000a2',1,'sold',1500,'ORDER-AMB', now() - interval '5 minutes');
insert into public.live_auction_item_skus
  (user_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot) values
 ('11111111-1111-1111-1111-111111111111','0d000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-0000000000a1',1,500,301),
 ('11111111-1111-1111-1111-111111111111','0d000000-0000-0000-0000-0000000000a2','0a000000-0000-0000-0000-0000000000a1',1,500,301);
