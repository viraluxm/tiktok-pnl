CREATE OR REPLACE FUNCTION public.lensed_recompute_sku_cost_scalar()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET lock_timeout TO '2s'
AS $function$
declare
  v_t0         timestamptz := clock_timestamp();
  v_skus       int;
  v_layers     int;
  v_candidates int;
  v_changed    int;
begin
  -- Visibility probe. Distinguishes "nothing to do" from "cannot see anything".
  select count(*) into v_skus   from public.inventory_skus;
  select count(*) into v_layers from public.sku_batches;

  with target as (
    select distinct on (b.sku_id) b.sku_id, b.unit_cost_cents
      from public.sku_batches b
     where b.qty_remaining > 0
     order by b.sku_id, b.sequence asc
  )
  select count(*) into v_candidates
    from public.inventory_skus s
    join target t on t.sku_id = s.id
   where t.unit_cost_cents is not null
     and s.unit_cost_cents is distinct from t.unit_cost_cents;

  -- Set-based: one statement for the whole catalog. No loop, no per-row function call.
  with target as (
    select distinct on (b.sku_id) b.sku_id, b.unit_cost_cents
      from public.sku_batches b
     where b.qty_remaining > 0
     order by b.sku_id, b.sequence asc
  )
  update public.inventory_skus s
     set unit_cost_cents = t.unit_cost_cents
    from target t
   where t.sku_id = s.id
     and t.unit_cost_cents is not null                        -- PRESERVE: never write NULL
     and s.unit_cost_cents is distinct from t.unit_cost_cents; -- idempotent
  get diagnostics v_changed = row_count;

  insert into public.sku_cost_mirror_runs
    (skus_seen, layers_seen, candidates, rows_changed, duration_ms)
  values
    (v_skus, v_layers, v_candidates, v_changed,
     (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int);

  delete from public.sku_cost_mirror_runs where ran_at < now() - interval '14 days';

  return v_changed;
end;
$function$

