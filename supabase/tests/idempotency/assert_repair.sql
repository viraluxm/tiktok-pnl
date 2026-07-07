-- Assertions for the conservative repair (unambiguous single-batch case).
do $$
declare v_rows int; v_qoh int; v_batch int; v_audit int;
        v_price_conf boolean; v_sku_conf boolean; v_seq int; v_keep uuid;
begin
  select count(*) into v_rows from public.live_auction_items
    where client_idempotency_key='ORDER-DUP' and user_id='11111111-1111-1111-1111-111111111111';
  if v_rows <> 1 then raise exception 'FAIL repair: expected 1 row for ORDER-DUP, got %', v_rows; end if;

  select id, sequence into v_keep, v_seq from public.live_auction_items where client_idempotency_key='ORDER-DUP';
  if v_keep <> '0d000000-0000-0000-0000-00000000000a' then raise exception 'FAIL repair: kept wrong (non-earliest) row %', v_keep; end if;
  if v_seq <> 1 then raise exception 'FAIL repair: kept sequence %, expected 1', v_seq; end if;

  select qty_on_hand into v_qoh from public.inventory_skus where id='0a000000-0000-0000-0000-000000000001';
  if v_qoh <> 9 then raise exception 'FAIL repair: qty_on_hand %, expected 9 (one draw restored)', v_qoh; end if;
  select qty_remaining into v_batch from public.sku_batches where id='0b000000-0000-0000-0000-000000000001';
  if v_batch <> 9 then raise exception 'FAIL repair: batch qty_remaining %, expected 9', v_batch; end if;

  select count(*) into v_audit from public.live_auction_dedup_repairs where order_id='ORDER-DUP';
  if v_audit <> 1 then raise exception 'FAIL repair: expected 1 audit row, got %', v_audit; end if;
  select price_conflict, sku_conflict into v_price_conf, v_sku_conf
    from public.live_auction_dedup_repairs where order_id='ORDER-DUP';
  if v_price_conf or v_sku_conf then raise exception 'FAIL repair: unexpected conflict flags p=% s=%', v_price_conf, v_sku_conf; end if;

  perform 1 from public.live_auction_item_skus where auction_item_id='0d000000-0000-0000-0000-00000000000b';
  if found then raise exception 'FAIL repair: removed row item_skus not cascaded'; end if;

  raise notice 'PASS repair: 1 canonical row kept, inventory restored 8->9, 1 audit row, no conflicts';
end $$;
