-- Assertions after 043 ABORTED on the ambiguous case: nothing must have changed.
do $$
declare v_rows int; v_qoh int;
begin
  -- The migration rolled back: new index + audit table must NOT exist.
  if to_regclass('public.idx_live_auction_items_user_idem') is not null then
    raise exception 'FAIL abort: new unique index exists — migration did not roll back';
  end if;
  if to_regclass('public.live_auction_dedup_repairs') is not null then
    raise exception 'FAIL abort: audit table exists — migration did not roll back';
  end if;
  -- The old per-session index must still be present (untouched).
  if to_regclass('public.idx_live_auction_items_idem') is null then
    raise exception 'FAIL abort: old per-session index was dropped';
  end if;
  -- Both duplicate rows must still be present, inventory unchanged.
  select count(*) into v_rows from public.live_auction_items where client_idempotency_key='ORDER-AMB';
  if v_rows <> 2 then raise exception 'FAIL abort: expected 2 dup rows intact, got %', v_rows; end if;
  select qty_on_hand into v_qoh from public.inventory_skus where id='0a000000-0000-0000-0000-0000000000a1';
  if v_qoh <> 8 then raise exception 'FAIL abort: qty_on_hand % changed (want 8, untouched)', v_qoh; end if;

  raise notice 'PASS abort: ambiguous repair aborted cleanly, nothing changed';
end $$;
