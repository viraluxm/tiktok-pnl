-- Pre-152 world. Runs AFTER 083+105 but BEFORE 152/153, so the rows it creates are
-- genuine legacy rows: batches with no cost_status/qty_added_authoritative concept, and
-- sale lines produced by the OLD bind RPC that never knew about source_batch_id.
--
-- Test H later proves migrations 152 and 153 left every one of them exactly as it is. The
-- snapshot table below is taken now, while "now" is still the old world.

do $$
declare
  A     uuid := '11111111-1111-1111-1111-111111111111';
  ORG1  uuid := '22222222-2222-2222-2222-222222222222';
  SKU_L uuid; SESS uuid; L1 uuid;
begin
  perform set_config('test.user_id', A::text, false);

  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values (A, ORG1, 900, 'LEGACY', 'Legacy SKU', 250, 0) returning id into SKU_L;

  -- A legacy layer shaped like 034's Option-A backfill: qty_added NULL, cost known.
  insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
    values (A, ORG1, SKU_L, 30, null, 250, 1) returning id into L1;
  update public.inventory_skus set qty_on_hand = qty_on_hand + 30 where id = SKU_L;

  insert into public.live_sessions (user_id, status) values (A, 'live') returning id into SESS;

  -- Three real binds through the PRE-152 lensed_log_auction.
  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SKU_L, 'qty', 2)), 'legacy-order-1', false, false);
  perform * from public.lensed_log_auction(SESS, 'sold',
    jsonb_build_array(jsonb_build_object('sku_id', SKU_L, 'qty', 3)), 'legacy-order-2', false, false);
  perform * from public.lensed_log_auction(SESS, 'not_sold',
    jsonb_build_array(jsonb_build_object('sku_id', SKU_L, 'qty', 1)), 'legacy-order-3', false, false);

  raise notice '✓ legacy world seeded (pre-152): sku=% batch=% session=%', SKU_L, L1, SESS;
end $$;

-- Freeze the pre-migration state so Test H can diff against it rather than against
-- hand-written expectations (CONVENTIONS.md: assert against what the producer really made).
create table legacy_snapshot as
  select las.id, las.inventory_sku_id, las.qty, las.unit_cost_cents_snapshot,
         las.sku_number_snapshot, las.title_snapshot, las.short_at_bind
    from public.live_auction_item_skus las;

create table legacy_batch_snapshot as
  select b.id, b.sku_id, b.qty_remaining, b.qty_added, b.unit_cost_cents, b.sequence
    from public.sku_batches b;

create table legacy_sku_snapshot as
  select s.id, s.qty_on_hand, s.unit_cost_cents from public.inventory_skus s;
