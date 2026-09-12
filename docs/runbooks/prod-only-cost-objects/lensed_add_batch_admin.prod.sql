CREATE OR REPLACE FUNCTION public.lensed_add_batch_admin(p_org_id uuid, p_sku_id uuid, p_qty integer, p_unit_cost_cents integer, p_external_ref text, p_system_user_id uuid)
 RETURNS TABLE(batch_id uuid, qty_on_hand integer, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_seq int;
  v_id uuid;
  v_existing uuid;
  v_qoh int;
begin
  if p_org_id is null then raise exception 'MISSING_ORG' using errcode='22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY' using errcode='22023'; end if;
  if p_unit_cost_cents is null or p_unit_cost_cents < 0 or p_unit_cost_cents > 100000 then
    raise exception 'INVALID_COST' using errcode='22023';
  end if;
  if p_external_ref is null or length(p_external_ref) = 0 then
    raise exception 'MISSING_REF' using errcode='22023';
  end if;

  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = p_org_id) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;

  v_user := coalesce(
    p_system_user_id,
    (select owner_user_id from public.organizations where id = p_org_id)
  );
  if v_user is null then raise exception 'NO_ATTRIBUTION_USER' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));

  select id into v_existing from public.sku_batches
    where org_id = p_org_id and source = 'viewtrack' and external_ref = p_external_ref;
  if found then
    select s.qty_on_hand into v_qoh from public.inventory_skus s where s.id = p_sku_id and s.org_id = p_org_id;
    batch_id := v_existing; qty_on_hand := v_qoh; replayed := true;
    return next; return;
  end if;

  select coalesce(max(sequence),0)+1 into v_seq
    from public.sku_batches where sku_id = p_sku_id and org_id = p_org_id;

  insert into public.sku_batches
    (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence, source, external_ref)
  values
    (v_user, p_org_id, p_sku_id, p_qty, p_qty, p_unit_cost_cents, v_seq, 'viewtrack', p_external_ref)
  returning id into v_id;

  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + p_qty
    where s.id = p_sku_id and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := v_id; qty_on_hand := v_qoh; replayed := false;
  return next;
end;
$function$

