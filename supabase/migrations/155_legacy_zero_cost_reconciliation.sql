-- 155: make legacy $0 placeholder-cost batches eligible for the SAME cost backfill as post-152
-- batches, by reconstructing their historical attribution ONLY where it can be proven.
--
-- REQUIRES 152 + 153 + 154 (live in production since 2026-09-13 00:56 UTC).
--
-- ── THE PROBLEM ───────────────────────────────────────────────────────────────────────
-- Before 152, entering a blank cost was impossible, so "we don't know the cost yet" was
-- recorded as unit_cost_cents = 0. Those layers' sales snapshotted 0 and are frozen there.
-- 154 can reprice a layer's sales, but only over rows carrying source_batch_id — and pre-153
-- draws discarded the batch id. So a legacy $0 layer has the right cost correction available
-- and nothing to apply it to.
--
-- This migration reconstructs that missing attribution, but ONLY where the database proves it,
-- and then promotes the layer into the post-152 model so it uses the ONE existing cost path
-- (lensed_finalize_batch_cost). It creates no second cost-correction system.
--
-- ── HOW ATTRIBUTION IS RECONSTRUCTED: REPLAY, THEN PROVE ──────────────────────────────
-- The reconstruction REPLAYS the SKU's actual draw history using Lensed's real FIFO rule, and
-- then refuses to believe itself unless two independent checks agree.
--
-- THE RULE BEING REPLAYED is the one lensed_log_auction actually implements, not textbook FIFO:
--   • a line draws its WHOLE quantity from ONE layer — allocations are never split;
--   • it picks the OLDEST layer by sequence whose remaining quantity covers the WHOLE line,
--     so an older layer that cannot cover it is SKIPPED (Option X), not partially consumed;
--   • a layer can only supply a draw that happened after the layer existed (created_at);
--   • if no layer can cover the line, the oversell path drives the NEWEST layer negative.
-- Draw order is the bind time: coalesce(live_auction_items.closed_at, line.created_at), which
-- is the flip time for a not_sold -> sold transition rather than the original staging time.
-- not_sold lines are excluded entirely: that path writes a sale line but draws NO stock.
--
-- THE TWO PROOFS, both required:
--   1. QUANTITY RECONCILIATION — after replaying every sold line, each layer's SIMULATED
--      remaining quantity must equal its ACTUAL qty_remaining. If anything else ever moved a
--      quantity — a manual lensed_edit_batch correction, a pre-153 settle (which zeroed
--      qty_remaining WITHOUT touching qty_added, and is therefore invisible afterwards), a
--      deleted auction item, an unbind restock — the simulation and reality diverge and the
--      whole SKU is refused.
--   2. GROUND TRUTH — every post-153 line already carries the batch the database itself
--      recorded at draw time. The replay must reproduce EVERY one of those exactly. This is
--      not a sanity check: it is the model being validated against real recorded outcomes on
--      the same SKU before its unrecorded history is trusted to the same model.
--
-- A single-layer SKU is simply the degenerate case of this replay: with one candidate layer
-- there is no allocation choice at all, and check 1 reduces to
-- qty_added - qty_remaining == SUM(sold qty).
--
-- Every layer on the SKU must have qty_added recorded. A NULL qty_added (the migration-034
-- Option-A backfill shape) gives the replay no starting quantity, so the SKU is refused.

-- ── SCOPE ─────────────────────────────────────────────────────────────────────────────
-- ONLY cost_status = 'legacy' AND unit_cost_cents = 0.
-- NOT positive-cost legacy layers. NOT NULL-cost legacy layers. NOT a genuine post-152
-- finalized $0 (that is cost_status='final' and is a real, deliberate zero — untouched here).

-- ══ 1. Audit trail for the one-time reconciliation ════════════════════════════════════
create table if not exists public.sku_batch_legacy_reconciliations (
  id uuid primary key default uuid_generate_v4(),
  batch_id uuid not null references public.sku_batches(id) on delete cascade,
  sku_id uuid not null references public.inventory_skus(id) on delete cascade,
  org_id uuid,
  actor_user_id uuid,
  -- the arithmetic that justified the reconstruction, frozen at the moment it was accepted
  qty_added integer not null,
  qty_remaining integer not null,
  implied_consumed integer not null,
  sold_units integer not null,
  lines_attributed integer not null,
  units_attributed integer not null,
  lines_already_attributed integer not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sku_batch_legacy_recon_batch
  on public.sku_batch_legacy_reconciliations (batch_id, created_at desc);

alter table public.sku_batch_legacy_reconciliations enable row level security;

-- Read-only to org members; written only by the service-role reconciliation RPC. No update or
-- delete policy: like sku_batch_cost_revisions, this is append-only evidence.
drop policy if exists sku_batch_legacy_recon_org_sel on public.sku_batch_legacy_reconciliations;
create policy sku_batch_legacy_recon_org_sel on public.sku_batch_legacy_reconciliations
  for select using (public.is_org_member(org_id));

comment on table public.sku_batch_legacy_reconciliations is
  'Append-only record of every legacy $0 batch promoted into the post-152 model by '
  'lensed_legacy_zero_cost_reconcile, including the reconciliation arithmetic that justified it.';

-- ══ 2. The reconciliation RPC — preview by default, applies only when asked ════════════
--
-- p_apply = false (DEFAULT) is a pure read: it classifies every legacy $0 batch and returns the
-- exact counts, changing nothing. That is the preview. p_apply = true performs the work.
--
-- SAFETY PROPERTIES
--   • Per-SKU advisory lock, the SAME key live sales/add/edit/settle/finalize take, acquired
--     BEFORE the state is read. A concurrent draw therefore cannot land between the
--     reconciliation check and the write — which matters because this runs against a database
--     that is actively selling.
--   • Never overwrites a non-NULL source_batch_id. Only `source_batch_id is null` rows are
--     touched, so post-153 attribution is preserved untouched.
--   • Conflicting attribution (a sold line for this SKU already pointing at a DIFFERENT batch)
--     refuses the whole batch rather than mixing reconstructions.
--   • Idempotent: a promoted batch is no longer cost_status='legacy', so it stops being a
--     candidate. A second run reports it nowhere and changes zero rows.
--   • Quantities are never touched: no qty_added, no qty_remaining, no qty_on_hand, no
--     sequence. A cost correction is not an inventory movement.
create or replace function public.lensed_legacy_zero_cost_reconcile(p_apply boolean default false)
returns table (
  batch_id uuid, sku_id uuid, sku_number integer, title text, verdict text,
  qty_added integer, qty_remaining integer, implied_consumed integer, sold_units integer,
  lines_to_attribute integer, units_to_attribute integer,
  lines_already_attributed integer, units_already_attributed integer,
  ground_truth_lines integer, applied boolean, detail text
)
language plpgsql security invoker as $$
declare
  r record; sk record; ln record;
  v_layers jsonb; v_key text;
  v_pick text; v_pick_created timestamptz; v_best text;
  v_rem int; v_qa int;
  v_alloc jsonb;              -- line id -> batch id chosen by the replay
  v_mismatch int; v_gt_total int; v_gt_bad int;
  v_verdict text; v_detail text; v_applied boolean;
  v_lines int; v_units int; v_already_lines int; v_already_units int; v_sold int;
begin
  -- One pass per SKU that owns at least one legacy $0 layer.
  for sk in
    select distinct b.sku_id as sid, s.sku_number as num, s.title as ttl
      from public.sku_batches b join public.inventory_skus s on s.id = b.sku_id
     where b.cost_status = 'legacy' and b.unit_cost_cents = 0
     order by 2
  loop
    -- Serialize against live sales on this SKU, THEN read. Order matters: this runs against a
    -- database that is actively selling.
    perform pg_advisory_xact_lock(hashtextextended('sku:'||sk.sid::text, 0));

    v_verdict := 'RECONSTRUCTABLE'; v_detail := null;

    -- ── load every layer on the SKU; a NULL qty_added makes replay impossible ──
    if exists (select 1 from public.sku_batches b where b.sku_id = sk.sid and b.qty_added is null) then
      v_verdict := 'AMBIGUOUS_QTY_ADDED_NULL';
      v_detail := 'a layer on this SKU has qty_added IS NULL (migration-034 backfill shape), so the replay has no starting quantity';
    end if;

    v_layers := '{}'::jsonb; v_alloc := '{}'::jsonb;
    if v_verdict = 'RECONSTRUCTABLE' then
      for r in select b.id, b.sequence, b.created_at, b.qty_added, b.qty_remaining
                 from public.sku_batches b where b.sku_id = sk.sid order by b.sequence
      loop
        v_layers := v_layers || jsonb_build_object(r.id::text, jsonb_build_object(
          'seq', r.sequence, 'created', r.created_at, 'sim', r.qty_added, 'actual', r.qty_remaining));
      end loop;

      -- ── REPLAY every SOLD line in draw order ──
      for ln in
        select l.id, l.qty, l.source_batch_id,
               coalesce(i.closed_at, l.created_at) as drawn_at
          from public.live_auction_item_skus l
          join public.live_auction_items i on i.id = l.auction_item_id
         where l.inventory_sku_id = sk.sid and i.status = 'sold'
         order by coalesce(i.closed_at, l.created_at), l.id
      loop
        -- oldest layer by sequence that EXISTED then and covers the WHOLE line (Option X)
        v_pick := null;
        for v_key in select k from jsonb_object_keys(v_layers) k
                      order by (v_layers -> k ->> 'seq')::int
        loop
          if (v_layers -> v_key ->> 'created')::timestamptz <= ln.drawn_at
             and (v_layers -> v_key ->> 'sim')::int >= ln.qty then
            v_pick := v_key; exit;
          end if;
        end loop;

        if v_pick is null then
          -- oversell: the NEWEST layer that existed goes negative
          v_best := null;
          for v_key in select k from jsonb_object_keys(v_layers) k
                        order by (v_layers -> k ->> 'seq')::int
          loop
            if (v_layers -> v_key ->> 'created')::timestamptz <= ln.drawn_at then v_best := v_key; end if;
          end loop;
          v_pick := v_best;
        end if;

        if v_pick is null then
          v_verdict := 'AMBIGUOUS_QUANTITY_UNRECONCILED';
          v_detail := 'a sold line predates every layer on this SKU, so no draw source can be reconstructed';
          exit;
        end if;

        v_layers := jsonb_set(v_layers, array[v_pick,'sim'],
                     to_jsonb((v_layers -> v_pick ->> 'sim')::int - ln.qty));
        v_alloc := v_alloc || jsonb_build_object(ln.id::text, v_pick);
      end loop;
    end if;

    -- ── PROOF 1: simulated remaining must equal actual remaining, for EVERY layer ──
    if v_verdict = 'RECONSTRUCTABLE' then
      v_mismatch := 0;
      for v_key in select k from jsonb_object_keys(v_layers) k loop
        if (v_layers -> v_key ->> 'sim')::int <> (v_layers -> v_key ->> 'actual')::int then
          v_mismatch := v_mismatch + 1;
        end if;
      end loop;
      if v_mismatch > 0 then
        v_verdict := 'AMBIGUOUS_QUANTITY_UNRECONCILED';
        v_detail := v_mismatch || ' layer(s) end the replay at a different quantity than the database holds — '
                 || 'an edit, a pre-153 settle, an unbind restock or a deleted auction item moved stock invisibly';
      end if;
    end if;

    -- ── PROOF 2: the replay must reproduce every already-recorded attribution exactly ──
    if v_verdict = 'RECONSTRUCTABLE' then
      v_gt_total := 0; v_gt_bad := 0;
      for ln in
        select l.id, l.source_batch_id from public.live_auction_item_skus l
          join public.live_auction_items i on i.id = l.auction_item_id
         where l.inventory_sku_id = sk.sid and i.status='sold' and l.source_batch_id is not null
      loop
        v_gt_total := v_gt_total + 1;
        if coalesce(v_alloc ->> ln.id::text, '') <> ln.source_batch_id::text then
          v_gt_bad := v_gt_bad + 1;
        end if;
      end loop;
      if v_gt_bad > 0 then
        v_verdict := 'AMBIGUOUS_REPLAY_CONTRADICTS_RECORDED';
        v_detail := v_gt_bad || ' of ' || v_gt_total || ' post-153 lines were recorded against a different '
                 || 'layer than the replay predicts — the reconstruction model does not hold for this SKU';
      end if;
    else
      v_gt_total := coalesce((select count(*) from public.live_auction_item_skus l
                                join public.live_auction_items i on i.id=l.auction_item_id
                               where l.inventory_sku_id=sk.sid and i.status='sold' and l.source_batch_id is not null), 0);
    end if;

    -- ── emit one row per legacy $0 layer on this SKU, applying if proven ──
    for r in select b.id, b.qty_added as qa, b.qty_remaining as qr, b.org_id
               from public.sku_batches b
              where b.sku_id = sk.sid and b.cost_status='legacy' and b.unit_cost_cents=0
              order by b.sequence
    loop
      select count(*)::int, coalesce(sum(l.qty),0)::int into v_lines, v_units
        from public.live_auction_item_skus l
        join public.live_auction_items i on i.id = l.auction_item_id
       where l.inventory_sku_id = sk.sid and i.status='sold' and l.source_batch_id is null
         and coalesce(v_alloc ->> l.id::text,'') = r.id::text;

      select count(*)::int, coalesce(sum(l.qty),0)::int into v_already_lines, v_already_units
        from public.live_auction_item_skus l where l.source_batch_id = r.id;

      select coalesce(sum(l.qty),0)::int into v_sold
        from public.live_auction_item_skus l join public.live_auction_items i on i.id=l.auction_item_id
       where l.inventory_sku_id = sk.sid and i.status='sold';

      v_applied := false;
      if p_apply and v_verdict = 'RECONSTRUCTABLE' then
        -- (a) persist ONLY the lines this replay assigned to THIS layer, and only where no
        --     attribution exists. `source_batch_id is null` is what makes this both
        --     non-destructive and idempotent.
        update public.live_auction_item_skus l
           set source_batch_id = r.id
          from public.live_auction_items i
         where i.id = l.auction_item_id
           and l.inventory_sku_id = sk.sid and i.status='sold'
           and l.source_batch_id is null
           and coalesce(v_alloc ->> l.id::text,'') = r.id::text;

        -- (b) promote into the post-152 model. cost_status and unit_cost_cents move together so
        --     sku_batches_cost_status_chk is never transiently violated and the layer is never
        --     observable half-converted. The 154 guard trigger does not fire: it keys on
        --     OLD.qty_added_authoritative, still false at this instant.
        update public.sku_batches b
           set unit_cost_cents = null, cost_status = 'pending', qty_added_authoritative = true
         where b.id = r.id;

        insert into public.sku_batch_legacy_reconciliations
          (batch_id, sku_id, org_id, actor_user_id, qty_added, qty_remaining, implied_consumed,
           sold_units, lines_attributed, units_attributed, lines_already_attributed)
        values (r.id, sk.sid, r.org_id, auth.uid(), r.qa, r.qr, (r.qa - r.qr),
                v_sold, v_lines, v_units, v_already_lines);
        v_applied := true;
      end if;

      batch_id := r.id; sku_id := sk.sid; sku_number := sk.num; title := sk.ttl;
      verdict := v_verdict; qty_added := r.qa; qty_remaining := r.qr;
      implied_consumed := case when r.qa is null then null else r.qa - r.qr end;
      sold_units := v_sold; lines_to_attribute := v_lines; units_to_attribute := v_units;
      lines_already_attributed := v_already_lines; units_already_attributed := v_already_units;
      ground_truth_lines := v_gt_total; applied := v_applied; detail := v_detail;
      return next;
    end loop;
  end loop;
end;
$$;

comment on function public.lensed_legacy_zero_cost_reconcile(boolean) is
  'Classifies every legacy $0 batch and, with p_apply=true, reconstructs its historical '
  'source_batch_id attribution and promotes it to (NULL, pending, authoritative) so it uses '
  'lensed_finalize_batch_cost like any post-152 batch. p_apply=false (default) is a pure '
  'read-only preview. Accepts ONLY single-layer SKUs whose quantity history reconciles; '
  'everything else is refused with an explicit AMBIGUOUS_* verdict. Never overwrites existing '
  'attribution and never changes a quantity.';

-- ══ Grants ════════════════════════════════════════════════════════════════════════════
-- A one-time admin reconciliation, not an app action. A newly created function has
-- proacl = NULL, which means PUBLIC (hence anon) holds EXECUTE implicitly and a grant does NOT
-- clear it — so the revoke is mandatory and must come first (same trap as 154).
revoke execute on function public.lensed_legacy_zero_cost_reconcile(boolean) from public, anon, authenticated;
grant  execute on function public.lensed_legacy_zero_cost_reconcile(boolean) to service_role;
