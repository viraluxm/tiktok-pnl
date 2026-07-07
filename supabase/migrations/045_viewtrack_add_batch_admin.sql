-- 045: ViewTrack integration — batch provenance + a service-role add-batch RPC.
--
-- WHY: an external app (ViewTrack) lands inventory into Lensed as a NEW FIFO cost
-- layer under an existing SKU, carrying the true landed unit cost. The existing
-- lensed_add_batch (035b) is SECURITY INVOKER and resolves org via
-- current_user_org()/auth.uid() — both NULL under the service role, so it cannot
-- be reused. This adds a SECURITY DEFINER variant that takes org + attribution
-- user + an idempotency ref EXPLICITLY, keeping the advisory-lock + qty-lockstep
-- invariants identical to 034/035b.
--
-- INVARIANT (unchanged): inventory_skus.qty_on_hand stays in lockstep with
-- Σ sku_batches.qty_remaining. This RPC bumps qty_on_hand by the new layer's qty.
-- It NEVER touches is_active (no auto-listing) and NEVER rewrites recorded sale
-- snapshots (Option A).

-- ── 1. Provenance + idempotency on the cost-layer table ─────────────────────
alter table public.sku_batches
  add column if not exists source text,          -- 'viewtrack' for integration-created layers
  add column if not exists external_ref text;    -- caller's stable id (ViewTrack shipment-line id)

-- A given external ref lands AT MOST ONCE per org — the real double-land guard.
create unique index if not exists uq_sku_batches_source_ref
  on public.sku_batches (org_id, source, external_ref)
  where source is not null;

-- ── 2. Service-role add-batch: explicit org + attribution user + idem ref ────
-- Returns the created (or replayed) batch plus the SKU's resulting qty_on_hand.
-- Bounds (locked with product): qty > 0 (no zero-qty layers); unit cost required
-- and 0..100000 cents ($0..$1,000/unit, no unbounded check).
create or replace function public.lensed_add_batch_admin(
  p_org_id uuid,
  p_sku_id uuid,
  p_qty int,
  p_unit_cost_cents int,
  p_external_ref text,
  p_system_user_id uuid
)
returns table (batch_id uuid, qty_on_hand int, replayed boolean)
language plpgsql
security definer
set search_path = public
as $$
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

  -- SKU must belong to the credential's org (defense in depth vs. the endpoint).
  if not exists (select 1 from public.inventory_skus where id = p_sku_id and org_id = p_org_id) then
    raise exception 'SKU_NOT_FOUND' using errcode='22023';
  end if;

  -- Attribution: the explicit integration user, else the org owner as a last
  -- resort (endpoint requires the env var, so the fallback should not fire).
  v_user := coalesce(
    p_system_user_id,
    (select owner_user_id from public.organizations where id = p_org_id)
  );
  if v_user is null then raise exception 'NO_ATTRIBUTION_USER' using errcode='22023'; end if;

  -- Serialize against live sales on the same SKU (same lock key as lensed_log_auction).
  perform pg_advisory_xact_lock(hashtextextended('sku:'||p_sku_id::text, 0));

  -- Idempotency: a replay returns the existing batch and does NOT bump qty again.
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
    (user_id, org_id, sku_id, qty_remaining, unit_cost_cents, sequence, source, external_ref)
  values
    (v_user, p_org_id, p_sku_id, p_qty, p_unit_cost_cents, v_seq, 'viewtrack', p_external_ref)
  returning id into v_id;

  -- Alias the target so the column is unambiguous vs. the OUT param `qty_on_hand`.
  update public.inventory_skus s set qty_on_hand = s.qty_on_hand + p_qty
    where s.id = p_sku_id and s.org_id = p_org_id
    returning s.qty_on_hand into v_qoh;

  batch_id := v_id; qty_on_hand := v_qoh; replayed := false;
  return next;
end;
$$;

-- Service-role only: NOT granted to `authenticated`. Reached solely via the
-- ViewTrack integration endpoint using the service role key.
revoke all on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from public;
revoke all on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from authenticated;
