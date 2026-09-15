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

-- ── SCOPE: TWO GROUPS ─────────────────────────────────────────────────────────────────
-- GROUP 1 — cost_status='legacy' AND unit_cost_cents=0. The untouched placeholder.
--   Promoted to (NULL,'pending',authoritative). The user then prices it through
--   lensed_finalize_batch_cost exactly like a new batch.
--
-- GROUP 2 — cost_status='final' AND qty_added_authoritative=false AND created_at < the 152
--   apply time. These are placeholders whose cost was ALREADY typed in through the inline
--   editor before this reconciliation could run: lensed_edit_batch set a positive cost and
--   flipped cost_status to 'final', but it reprices no history, so their past sales are
--   stranded at $0 COGS and they fall out of Group 1.
--
--   WHY THAT SIGNATURE IS A PROOF, NOT AN INFERENCE. Every post-152 path that CREATES a batch
--   sets qty_added_authoritative = true — lensed_add_batch, lensed_add_batch_admin, the
--   create-SKU seed row, and the lensed_unbind restock layer. So 'final' + authoritative=false
--   cannot be produced by any creation path. Combined with created_at predating the 152 apply
--   (which proves the row's cost_status started as the migration's 'legacy' default), the only
--   writer that can have produced this state is lensed_edit_batch on a legacy row. Cost is
--   never used to infer it.
--
--   WHAT GETS REPRICED, AND WHAT DOES NOT. Only attributed historical lines whose snapshot is
--   exactly 0 — the placeholder value. A line carrying a real non-zero snapshot was drawn when
--   the layer genuinely held that cost and is left alone, so a layer that was priced correctly
--   for part of its life does not get its good history overwritten. (Production has exactly
--   this case: SKU 452 has 9 lines at $0 and 1 at a real cost.)
--
-- NEITHER GROUP TOUCHES: positive-cost legacy layers that were never edited, NULL-cost legacy
-- layers, or a genuine post-152 finalized $0 — that is (0,'final') WITH authoritative=true, a
-- deliberate real cost, and it fails the Group 2 signature.

-- ══ 0. Never queue behind a live sale ═════════════════════════════════════════════════
-- The audit table's FKs reference sku_batches and inventory_skus, and creating a FK takes
-- SHARE ROW EXCLUSIVE on the REFERENCED table — which conflicts with the ROW EXCLUSIVE every
-- live bind holds. Without a bound, this migration would sit in the lock queue during a show
-- and every bind arriving behind it would queue too. 3s means it gives up instead.
set local lock_timeout = '3s';

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
  -- PROMOTE_PENDING: a legacy $0 layer became (NULL,'pending',authoritative) and the user will
  -- price it through lensed_finalize_batch_cost like any new batch.
  -- RECOVER_FINAL: a legacy layer whose cost had ALREADY been typed in through the inline
  -- editor before this reconciliation could run. Its cost is kept as-is and its stranded $0
  -- historical lines are repriced to it immediately.
  mode text not null default 'PROMOTE_PENDING',
  applied_cost_cents integer,
  lines_repriced integer not null default 0,
  units_repriced integer not null default 0,
  cogs_delta_cents bigint not null default 0,
  created_at timestamptz not null default now()
);

-- Added after the first revision of this migration, so re-running over a database that already
-- has the table converges on the same shape.
alter table public.sku_batch_legacy_reconciliations
  add column if not exists mode text not null default 'PROMOTE_PENDING',
  add column if not exists applied_cost_cents integer,
  add column if not exists lines_repriced integer not null default 0,
  add column if not exists units_repriced integer not null default 0,
  add column if not exists cogs_delta_cents bigint not null default 0;

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
-- An earlier revision of this migration had a single-argument signature. CREATE OR REPLACE
-- cannot replace it (the argument list differs), so it must be dropped or both would exist and
-- a no-argument call would be ambiguous.
drop function if exists public.lensed_legacy_zero_cost_reconcile(boolean);

create or replace function public.lensed_legacy_zero_cost_reconcile(
  p_apply boolean default false,
  -- The moment migration 152 was applied to production. Any batch created before this had its
  -- cost_status set by 152's own DEFAULT 'legacy', which is what makes the Group 2 signature a
  -- proof rather than a guess. Overridable so the test harness can seed a pre-feature world.
  p_pre_feature_cutoff timestamptz default '2026-09-13 00:56:47+00'
)
returns table (
  batch_id uuid, sku_id uuid, sku_number integer, title text, grp text, verdict text,
  qty_added integer, qty_remaining integer, implied_consumed integer, sold_units integer,
  lines_to_attribute integer, units_to_attribute integer,
  lines_to_reprice integer, units_to_reprice integer, cost_to_apply integer,
  lines_already_attributed integer, units_already_attributed integer,
  ground_truth_lines integer, applied boolean, detail text
)
language plpgsql security invoker as $$
declare
  r record; sk record; ln record;
  v_layers jsonb; v_key text; v_pick text; v_best text;
  v_alloc jsonb; v_mismatch int; v_gt_total int; v_gt_bad int;
  v_verdict text; v_detail text; v_applied boolean; v_grp text;
  v_lines int; v_units int; v_rep_lines int; v_rep_units int;
  v_already_lines int; v_already_units int; v_sold int;
  v_prev_cogs bigint; v_new_cogs bigint;
begin
  for sk in
    select distinct b.sku_id as sid, s.sku_number as num, s.title as ttl
      from public.sku_batches b join public.inventory_skus s on s.id = b.sku_id
     where (b.cost_status = 'legacy' and b.unit_cost_cents = 0)
        or (b.cost_status = 'final' and b.qty_added_authoritative = false
            and b.created_at < p_pre_feature_cutoff)
     order by 2
  loop
    perform pg_advisory_xact_lock(hashtextextended('sku:'||sk.sid::text, 0));
    v_verdict := 'RECONSTRUCTABLE'; v_detail := null;

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

      for ln in
        select l.id, l.qty, coalesce(i.closed_at, l.created_at) as drawn_at
          from public.live_auction_item_skus l
          join public.live_auction_items i on i.id = l.auction_item_id
         where l.inventory_sku_id = sk.sid and i.status = 'sold'
         order by coalesce(i.closed_at, l.created_at), l.id
      loop
        v_pick := null;
        for v_key in select k from jsonb_object_keys(v_layers) k order by (v_layers -> k ->> 'seq')::int
        loop
          if (v_layers -> v_key ->> 'created')::timestamptz <= ln.drawn_at
             and (v_layers -> v_key ->> 'sim')::int >= ln.qty then
            v_pick := v_key; exit;
          end if;
        end loop;
        if v_pick is null then
          v_best := null;
          for v_key in select k from jsonb_object_keys(v_layers) k order by (v_layers -> k ->> 'seq')::int
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
        v_layers := jsonb_set(v_layers, array[v_pick,'sim'], to_jsonb((v_layers -> v_pick ->> 'sim')::int - ln.qty));
        v_alloc := v_alloc || jsonb_build_object(ln.id::text, v_pick);
      end loop;
    end if;

    -- PROOF 1: simulated remaining == actual remaining, for EVERY layer
    if v_verdict = 'RECONSTRUCTABLE' then
      v_mismatch := 0;
      for v_key in select k from jsonb_object_keys(v_layers) k loop
        if (v_layers -> v_key ->> 'sim')::int <> (v_layers -> v_key ->> 'actual')::int then
          v_mismatch := v_mismatch + 1; end if;
      end loop;
      if v_mismatch > 0 then
        v_verdict := 'AMBIGUOUS_QUANTITY_UNRECONCILED';
        v_detail := v_mismatch || ' layer(s) end the replay at a different quantity than the database holds — '
                 || 'an edit, a pre-153 settle, an unbind restock or a deleted auction item moved stock invisibly';
      end if;
    end if;

    -- PROOF 2: the replay reproduces every already-recorded attribution exactly
    v_gt_total := 0;
    if v_verdict = 'RECONSTRUCTABLE' then
      v_gt_bad := 0;
      for ln in
        select l.id, l.source_batch_id from public.live_auction_item_skus l
          join public.live_auction_items i on i.id = l.auction_item_id
         where l.inventory_sku_id = sk.sid and i.status='sold' and l.source_batch_id is not null
      loop
        v_gt_total := v_gt_total + 1;
        if coalesce(v_alloc ->> ln.id::text,'') <> ln.source_batch_id::text then v_gt_bad := v_gt_bad + 1; end if;
      end loop;
      if v_gt_bad > 0 then
        v_verdict := 'AMBIGUOUS_REPLAY_CONTRADICTS_RECORDED';
        v_detail := v_gt_bad || ' of ' || v_gt_total || ' post-153 lines were recorded against a different '
                 || 'layer than the replay predicts — the reconstruction model does not hold for this SKU';
      end if;
    else
      select count(*)::int into v_gt_total from public.live_auction_item_skus l
        join public.live_auction_items i on i.id=l.auction_item_id
       where l.inventory_sku_id=sk.sid and i.status='sold' and l.source_batch_id is not null;
    end if;

    -- one row per in-scope layer on this SKU
    for r in select b.id, b.qty_added as qa, b.qty_remaining as qr, b.org_id, b.unit_cost_cents as cost,
                    case when b.cost_status='legacy' then 'PROMOTE_PENDING' else 'RECOVER_FINAL' end as mode
               from public.sku_batches b
              where b.sku_id = sk.sid
                and ((b.cost_status='legacy' and b.unit_cost_cents=0)
                  or (b.cost_status='final' and b.qty_added_authoritative=false
                      and b.created_at < p_pre_feature_cutoff))
              order by b.sequence
    loop
      v_grp := r.mode;

      select count(*)::int, coalesce(sum(l.qty),0)::int into v_lines, v_units
        from public.live_auction_item_skus l join public.live_auction_items i on i.id = l.auction_item_id
       where l.inventory_sku_id = sk.sid and i.status='sold' and l.source_batch_id is null
         and coalesce(v_alloc ->> l.id::text,'') = r.id::text;

      -- Lines this layer will immediately reprice: ONLY the $0 placeholder ones (already
      -- attributed, or about to be). A real non-zero snapshot is left alone.
      select count(*)::int, coalesce(sum(l.qty),0)::int into v_rep_lines, v_rep_units
        from public.live_auction_item_skus l join public.live_auction_items i on i.id = l.auction_item_id
       where l.inventory_sku_id = sk.sid and i.status='sold'
         and l.unit_cost_cents_snapshot = 0
         and (l.source_batch_id = r.id
              or (l.source_batch_id is null and coalesce(v_alloc ->> l.id::text,'') = r.id::text));
      -- Only RECOVER_FINAL reprices anything, and only a batch that actually passed both
      -- proofs will be acted on — a refused batch reports zero work rather than a phantom plan.
      if r.mode <> 'RECOVER_FINAL' or v_verdict <> 'RECONSTRUCTABLE' then
        v_rep_lines := 0; v_rep_units := 0;
      end if;

      select count(*)::int, coalesce(sum(l.qty),0)::int into v_already_lines, v_already_units
        from public.live_auction_item_skus l where l.source_batch_id = r.id;
      select coalesce(sum(l.qty),0)::int into v_sold
        from public.live_auction_item_skus l join public.live_auction_items i on i.id=l.auction_item_id
       where l.inventory_sku_id = sk.sid and i.status='sold';

      v_applied := false; v_prev_cogs := 0; v_new_cogs := 0;
      if p_apply and v_verdict = 'RECONSTRUCTABLE' then
        update public.live_auction_item_skus l
           set source_batch_id = r.id
          from public.live_auction_items i
         where i.id = l.auction_item_id and l.inventory_sku_id = sk.sid and i.status='sold'
           and l.source_batch_id is null
           and coalesce(v_alloc ->> l.id::text,'') = r.id::text;

        if r.mode = 'PROMOTE_PENDING' then
          update public.sku_batches b
             set unit_cost_cents = null, cost_status = 'pending', qty_added_authoritative = true
           where b.id = r.id;
        else
          -- RECOVER_FINAL: the cost the user already typed is KEPT. Only the stranded $0
          -- historical lines move to it. The 154 guard trigger does not fire — the cost is not
          -- being changed, only qty_added_authoritative.
          v_prev_cogs := 0;                       -- those lines carry exactly 0 by definition
          v_new_cogs  := v_rep_units::bigint * r.cost;

          update public.sku_batches b set qty_added_authoritative = true where b.id = r.id;

          update public.live_auction_item_skus l
             set unit_cost_cents_snapshot = r.cost
            from public.live_auction_items i
           where i.id = l.auction_item_id and l.inventory_sku_id = sk.sid and i.status='sold'
             and l.source_batch_id = r.id and l.unit_cost_cents_snapshot = 0;

          -- The COGS movement is recorded in sku_batch_legacy_reconciliations below, NOT in
          -- sku_batch_cost_revisions. Two reasons, both substantive:
          --   • This is not a batch cost revision. The batch's unit_cost_cents does not change
          --     here (it is already r.cost); what changes is which historical lines carry it.
          --     A row claiming old=0 -> new=125 would misstate the batch's own cost history.
          --   • sku_batch_cost_revisions.actor_user_id is NOT NULL -> auth.users. This RPC runs
          --     as service_role with auth.uid() = NULL, so writing there would mean inventing a
          --     human actor for a migration. The reconciliation table allows a null actor
          --     precisely because no human performed it.
          -- The reconciliation row carries batch_id, applied_cost_cents, lines/units repriced and
          -- the exact cogs_delta_cents, so the COGS move is fully auditable and joinable.
        end if;

        insert into public.sku_batch_legacy_reconciliations
          (batch_id, sku_id, org_id, actor_user_id, qty_added, qty_remaining, implied_consumed,
           sold_units, lines_attributed, units_attributed, lines_already_attributed,
           mode, applied_cost_cents, lines_repriced, units_repriced, cogs_delta_cents)
        values (r.id, sk.sid, r.org_id, auth.uid(), r.qa, r.qr, (r.qa - r.qr), v_sold,
                v_lines, v_units, v_already_lines, r.mode,
                case when r.mode='RECOVER_FINAL' then r.cost end,
                v_rep_lines, v_rep_units,
                case when r.mode='RECOVER_FINAL' then v_new_cogs - v_prev_cogs else 0 end);
        v_applied := true;
      end if;

      batch_id := r.id; sku_id := sk.sid; sku_number := sk.num; title := sk.ttl;
      grp := v_grp; verdict := v_verdict; qty_added := r.qa; qty_remaining := r.qr;
      implied_consumed := case when r.qa is null then null else r.qa - r.qr end;
      sold_units := v_sold; lines_to_attribute := v_lines; units_to_attribute := v_units;
      lines_to_reprice := v_rep_lines; units_to_reprice := v_rep_units;
      cost_to_apply := case when r.mode='RECOVER_FINAL' then r.cost end;
      lines_already_attributed := v_already_lines; units_already_attributed := v_already_units;
      ground_truth_lines := v_gt_total; applied := v_applied; detail := v_detail;
      return next;
    end loop;
  end loop;
end;
$$;

comment on function public.lensed_legacy_zero_cost_reconcile(boolean, timestamptz) is
  'One-time reconciliation of pre-152 placeholder-cost batches. Reconstructs a batch''s missing '
  'historical source_batch_id by replaying the SKU''s real FIFO draw history, and accepts it '
  'only when the replay reproduces every layer''s actual qty_remaining AND every attribution '
  'the database already recorded post-153. PROMOTE_PENDING moves an untouched legacy $0 layer '
  'to (NULL, pending, authoritative) so it is priced through lensed_finalize_batch_cost like '
  'any post-152 batch. RECOVER_FINAL handles a legacy layer already edited to a positive cost '
  'before this ran: it keeps that cost and cost_status=final, makes the layer attributable, and '
  'reprices only its stranded $0 historical lines. p_apply=false (default) is a pure read-only '
  'preview. Anything unprovable is refused with an explicit AMBIGUOUS_* verdict. Never '
  'overwrites existing attribution, never rewrites a non-zero snapshot, never changes a quantity.';

-- ══ Grants ════════════════════════════════════════════════════════════════════════════
-- A one-time admin reconciliation, not an app action. A newly created function has
-- proacl = NULL, which means PUBLIC (hence anon) holds EXECUTE implicitly and a grant does NOT
-- clear it — so the revoke is mandatory and must come first (same trap as 154).
revoke execute on function public.lensed_legacy_zero_cost_reconcile(boolean, timestamptz) from public, anon, authenticated;
grant  execute on function public.lensed_legacy_zero_cost_reconcile(boolean, timestamptz) to service_role;
