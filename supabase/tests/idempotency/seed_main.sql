-- Simulate the PRE-FIX bug on the "main" DB: the same TikTok order 'ORDER-DUP' was
-- captured into TWO forked sessions → two auction rows (each sequence 1) + TWO
-- inventory draws (qty_on_hand 10 → 8, batch 10 → 8). 043's repair must collapse this.
insert into public.inventory_skus (id, user_id, org_id, sku_number, title, unit_cost_cents, qty_on_hand)
values ('0a000000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        101,'Dup SKU',500,8);
insert into public.sku_batches (id, user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence)
values ('0b000000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        '0a000000-0000-0000-0000-000000000001',8,500,1);

insert into public.live_sessions (id, user_id, status, source) values
 ('0c000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','live','extension'),
 ('0c000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','live','extension');

-- Earliest row (session A) is canonical; later row (session B) is the duplicate.
insert into public.live_auction_items
  (id, user_id, session_id, sequence, status, expected_price_cents, client_idempotency_key, created_at) values
 ('0d000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-00000000000a',1,'sold',1500,'ORDER-DUP', now() - interval '10 minutes'),
 ('0d000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111',
  '0c000000-0000-0000-0000-00000000000b',1,'sold',1500,'ORDER-DUP', now() - interval '5 minutes');
insert into public.live_auction_item_skus
  (user_id, auction_item_id, inventory_sku_id, qty, unit_cost_cents_snapshot, sku_number_snapshot) values
 ('11111111-1111-1111-1111-111111111111','0d000000-0000-0000-0000-00000000000a','0a000000-0000-0000-0000-000000000001',1,500,101),
 ('11111111-1111-1111-1111-111111111111','0d000000-0000-0000-0000-00000000000b','0a000000-0000-0000-0000-000000000001',1,500,101);
