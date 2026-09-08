-- 134_squish_multibind_audit.sql
--
-- RENAMED FROM 129_squish_multibind_audit.sql. A COMMITTED 129_schedule_phase2_offer_lifecycle.sql
-- on another branch also claims prefix 129 and has precedence (same resolution as 094, which was
-- renamed off 076 for the same reason). Renumbered to 134 — the next prefix free across all
-- branches, remotes and sibling worktrees as of 2026-09-08 (130-133 are taken: two 130s, 131
-- manual_worked_shift_rpc, 132 tracking_history_trigger, 133 order_refund_state).
--
-- ALREADY APPLIED TO LIVE on 2026-09-07 under the Class A recipe, verified in that session:
-- capture_events kept landing across the window (151,875 -> 151,878) and the prosrc md5 of
-- lensed_unbind / lensed_log_auction / lensed_log_auction_as were byte-identical before and after
-- (nothing existing was replaced). DO NOT REPLAY — every object below already exists on live.
-- The content below is UNCHANGED from what ran; only the filename prefix moved.
--
-- The squish over-bind audit queue: find orders that had MORE THAN ONE unit bound to them when
-- every bound SKU is a squish, and give the team the two writes needed to resolve one.
--
-- THE FACT. The capture extension holds a STAGED SKU list (extension/tiktok-content.js:177) and
-- binds whatever is staged when a sale lands (autoBind, :1221 → clearStaged, :1310). So a host who
-- scans the next item before the previous sale is captured — or scans one item twice (":1144 same
-- barcode again → increments qty") — puts two units on ONE order. For electronics that is a real
-- bundle. For squish it is always an error: squish is never bundled.
--
-- WHY CATEGORY IS THE ONLY DISCRIMINATOR. synced_order_ids.units — TikTok's own unit count — is 1
-- for EVERY multi-unit bound order in prod, the legitimate electronics bundles included (checked
-- 2026-09-06: 3,761 electronics / 2,654 squish, all units=1). TikTok counts the listing, not the
-- pieces, so the platform carries no signal that separates a bundle from a double-scan.
-- inventory_skus.category does, and it is 424/425 tagged.
--
-- WHY Σqty > 1 AND NOT is_bundle. live_auction_items.is_bundle is set from
-- jsonb_array_length(p_skus) > 1, so it is FALSE for the same-item-scanned-twice case (one line,
-- qty 2) — 285 of the 2,654 squish cases in prod. The line grain is the only correct test.
--
-- CONTENTS (all THREE objects are NEW NAMES — nothing existing is replaced, dropped or rewritten):
--   a) bind_review_decisions   — "reviewed, this one is fine" so a dismissed order stays dismissed
--   b) squish_multibind_audit_as — the owner-scoped queue read (service_role only)
--   c) lensed_unbind_as        — service-role unbind, generated from the LIVE lensed_unbind body
--
-- CLASS A (per the lock-footprint gate): one CREATE TABLE with a new name, two new functions, no
-- ALTER of any existing table, no create-or-replace of any live-path function. Nothing on the
-- capture or order-sync write path takes a lock from this file.

begin;

-- Applied mid-show (the operation is 24/7; write-activity silence is unsatisfiable). Class A =
-- additive, NEW object names only: one CREATE TABLE, two CREATE FUNCTIONs, no ALTER of any
-- existing table and no create-or-replace of any live-path function. lock_timeout means that if
-- this ever DID contend for a lock it fails fast instead of queueing ahead of a capture write.
set local lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- a) bind_review_decisions — the team's "not an error, keep both" verdict.
--
-- WHY IT EXISTS. Without it the queue can never shrink: a legitimately multi-unit squish order (a
-- mis-tagged SKU, a genuine two-piece deal) would resurface every single day and the team would
-- learn to ignore the queue. A dismissal must stick.
--
-- KEYED ON (order_id, item_id), NOT order_id ALONE. item_id is the live_auction_items row, and a
-- correction DELETES that row (lensed_unbind) so a re-bind gets a FRESH id. Keying on the item
-- means a dismissal suppresses exactly the state that was reviewed: if the order is later re-bound
-- and is over-bound AGAIN, it is a new item_id and it re-enters the queue. Keying on order_id
-- alone would silently hide the second mistake forever.
--
-- RLS ON WITH NO POLICIES — service_role only, same posture as bind_audit (084).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.bind_review_decisions (
  id            uuid primary key default gen_random_uuid(),
  order_id      text not null,
  item_id       uuid not null,          -- the live_auction_items row that was reviewed
  owner_user_id uuid not null,
  actor_user_id uuid not null,          -- the member who made the call
  decision      text not null check (decision in ('keep_multi')),
  units         int,                    -- units bound at decision time (what they actually saw)
  note          text,
  created_at    timestamptz not null default now()
);

-- One verdict per reviewed item; the route upserts on this.
create unique index if not exists uq_bind_review_decisions_order_item
  on public.bind_review_decisions (order_id, item_id);

alter table public.bind_review_decisions enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes this.

comment on table public.bind_review_decisions is
  'Append-only team verdicts on the squish over-bind audit queue. decision=keep_multi means "this '
  'multi-unit squish order is NOT an error, stop showing it". Keyed on (order_id, item_id) so a '
  're-bound order that is over-bound again re-enters the queue under its new item_id.';

-- ─────────────────────────────────────────────────────────────────────────────
-- b) squish_multibind_audit_as — the queue read.
--
-- WHY AN RPC AND NOT PostgREST. The flag is a GROUP BY / HAVING across three tables
-- (live_auction_items → live_auction_item_skus → inventory_skus). PostgREST cannot express it, and
-- reading the tables separately would hit the silent 1,000-row read cap — wrong numbers that look
-- right. One RPC, one predicate, one place to change it.
--
-- THE PREDICATE, exactly:
--   • status = 'sold'                    — a not_sold item drew no stock and is not a customer order
--   • client_idempotency_key is a real order id (not '' / '0')
--   • Σ line qty > 1                     — the flag; covers BOTH failure modes (see header)
--   • every line's SKU category = 'squish' — electronics (and mixed, and untagged) are NOT flagged
--   • bound_at >= p_since                — the queue is a worklist, not the whole archive
--   • no bind_review_decisions row for THIS item_id
--   • synced status <> 'CANCELLED'        — a cancelled order is not worth a correction
--   • store scope: p_all_stores, else the order's store must be one of p_store_ids
--
-- STORE SCOPE IS TAKEN FROM synced_order_ids FIRST. live_auction_items.store_id is stamped at
-- insert and never retro-filled, so thousands of rows carry NULL (the known backfill gap) — using
-- it alone would hide a store-restricted member's own orders. coalesce(synced, item) mirrors what
-- /api/member/unbound already does.
--
-- EVERY JOIN IS PINNED TO THE ITEM'S OWN user_id, never to `= any(p_owner_user_ids)`: with more
-- than one owner in scope, an order id present under two owners would fan the row out and
-- double-count it.
--
-- total_count rides on every row (count(*) over ()) so the UI can page with real page numbers
-- instead of a keyset guess. The queue is small by construction (a 14-day window).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.squish_multibind_audit_as(
  p_owner_user_ids uuid[],
  p_store_ids      uuid[],
  p_all_stores     boolean,
  p_since          timestamptz,
  p_limit          int default 50,
  p_offset         int default 0
)
returns table(
  order_id         text,
  item_id          uuid,
  session_id       uuid,
  owner_user_id    uuid,
  store_id         uuid,
  bound_at         timestamptz,
  units            int,
  line_count       int,
  tiktok_title     text,
  buyer_handle     text,
  won_price_cents  int,
  lot_hint         text,
  ordered_at       timestamptz,
  tiktok_status    text,
  tracking_number  text,
  lines            jsonb,
  total_count      bigint
)
language sql
stable
as $function$
  with flagged as (
    select
      lai.client_idempotency_key                as order_id,
      lai.id                                    as item_id,
      lai.session_id                            as session_id,
      lai.user_id                               as owner_user_id,
      lai.store_id                              as item_store_id,
      lai.created_at                            as bound_at,
      sum(las.qty)::int                         as units,
      count(*)::int                             as line_count,
      jsonb_agg(jsonb_build_object(
        'sku_id',          las.inventory_sku_id,
        'sku_number',      las.sku_number_snapshot,
        'title',           las.title_snapshot,
        'qty',             las.qty,
        'unit_cost_cents', las.unit_cost_cents_snapshot,
        'category',        isk.category,
        'thumbnail_path',  isk.thumbnail_path
      ) order by las.sku_number_snapshot nulls last) as lines
    from public.live_auction_items lai
    join public.live_auction_item_skus las
      on las.auction_item_id = lai.id and las.user_id = lai.user_id
    left join public.inventory_skus isk
      on isk.id = las.inventory_sku_id
    where lai.user_id = any(p_owner_user_ids)
      and lai.status = 'sold'
      and coalesce(lai.client_idempotency_key, '') not in ('', '0')
      and lai.created_at >= p_since
    group by lai.client_idempotency_key, lai.id, lai.session_id, lai.user_id, lai.store_id, lai.created_at
    having sum(las.qty) > 1
       and bool_and(coalesce(isk.category, '') = 'squish')
  )
  select
    f.order_id,
    f.item_id,
    f.session_id,
    f.owner_user_id,
    coalesce(soi.store_id, f.item_store_id)     as store_id,
    f.bound_at,
    f.units,
    f.line_count,
    ce.product_name                             as tiktok_title,
    ce.buyer_username                           as buyer_handle,
    ce.selling_price_cents                      as won_price_cents,
    ce.platform_sku_ref                         as lot_hint,
    ce.ordered_at                               as ordered_at,
    soi.status                                  as tiktok_status,
    soi.tracking_number                         as tracking_number,
    f.lines,
    count(*) over ()                            as total_count
  from flagged f
  left join public.capture_events ce
    on ce.order_id = f.order_id and ce.user_id = f.owner_user_id
  left join public.synced_order_ids soi
    on soi.order_id = f.order_id and soi.user_id = f.owner_user_id
  where (p_all_stores or coalesce(soi.store_id, f.item_store_id) = any(p_store_ids))
    and coalesce(soi.status, '') <> 'CANCELLED'
    and not exists (
      select 1 from public.bind_review_decisions d
      where d.order_id = f.order_id and d.item_id = f.item_id
    )
  order by f.bound_at desc, f.order_id desc
  limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- service_role ONLY: the function trusts p_owner_user_ids, so it must never be reachable by an end
-- user. (rpc-grants CI keeps it in SERVICE_ROLE_ONLY — granting it would be a cross-tenant leak.)
revoke execute on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int) from public, anon, authenticated;
grant  execute on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int) to service_role;

comment on function public.squish_multibind_audit_as(uuid[], uuid[], boolean, timestamptz, int, int) is
  'Squish over-bind audit queue: sold orders whose bound lines are ALL squish and total more than '
  'one unit, minus dismissed ones. Read-only. service_role only (trusts p_owner_user_ids).';

-- ─────────────────────────────────────────────────────────────────────────────
-- c) lensed_unbind_as — the correction write, callable under the service role.
--
-- WHY IT IS NEEDED AT ALL. lensed_unbind reads auth.uid() and current_user_org(), both NULL under
-- the service role, and the team members who work these queues ARE service-role/owner-scoped
-- (requireMemberScope). So a member cannot unbind today — the correction path exists only for an
-- owner session. This is the same problem 084 solved for the bind side with lensed_log_auction_as,
-- and it is solved the same way: a sibling that takes the owner explicitly.
--
-- PROVENANCE. The body below is pg_get_functiondef(public.lensed_unbind) pulled from LIVE on
-- 2026-09-06 (byte-identical to the repo's 083 copy — verified), with FIVE edits applied
-- programmatically, each anchor asserted to match EXACTLY ONCE, and the result diffed back against
-- the live text to prove nothing else moved. Not hand-copied, not reconstructed.
--
--   EDIT 1  signature      → lensed_unbind_as(p_owner_user_id uuid, p_order_id text)
--   EDIT 2  v_user         → p_owner_user_id            (was auth.uid())
--   EDIT 3  v_org          → organization_members lookup (was current_user_org()), as in 084
--   EDIT 4  external_ref   → order:sku:ITEM_ID           (was order:sku)   ← see below
--   EDIT 5  raise notice   → 'lensed_unbind_as:'         (log separation only)
--
-- EDIT 4 IS THE ONE BEHAVIOURAL DIVERGENCE, AND IT IS DELIBERATE. uq_sku_batches_source_ref is
-- UNIQUE (org_id, source, external_ref) WHERE source IS NOT NULL — confirmed present on live as a
-- partial unique INDEX (it is not a table constraint, which is why it does not show in
-- pg_constraint). With external_ref = order:sku, a SECOND unbind of the same (order, sku) raises
-- 23505 and rolls the whole unbind back. Today that is nearly unreachable; this feature makes it
-- ordinary — a member corrects an order, keeps the wrong line, and corrects it again. item_id is
-- fresh on every bind, so keying the restock layer on it makes each unbind event's layer distinct.
-- lensed_unbind itself is NOT touched: the extension and the owner-session route keep the exact
-- function they have today.
--
-- FIFO NOTE (true of the existing unbind too, restated because the audit queue will exercise it
-- thousands of times): the restock lands as a NEW TAIL layer at the snapshot cost, while the
-- re-bind draws from the EARLIEST layer with stock. So a corrected order's COGS can differ by
-- cents from the original. That is the accepted behaviour of the correction path, not a new bug.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lensed_unbind_as(p_owner_user_id uuid, p_order_id text)
 RETURNS TABLE(unbound boolean, item_id uuid, restocked_lines integer, restocked_units integer)
 LANGUAGE plpgsql
AS $function$
declare
  v_user uuid := p_owner_user_id;   -- CHANGED from: auth.uid()
  v_org  uuid := (                  -- CHANGED from: public.current_user_org()
    select m.org_id from public.organization_members m
    where m.user_id = p_owner_user_id order by m.created_at limit 1);
  v_item record; v_line record; v_seq int; v_n int := 0; v_u int := 0;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='28000'; end if;
  if v_org  is null then raise exception 'NO_ORG' using errcode='P0001'; end if;
  if p_order_id is null or length(p_order_id) = 0 then raise exception 'NO_ORDER' using errcode='22023'; end if;

  -- serialize ops on this order key (idempotency + concurrency)
  perform pg_advisory_xact_lock(hashtextextended('unbind:'||p_order_id, 0));

  select i.id into v_item
    from public.live_auction_items i
    where i.user_id = v_user and i.client_idempotency_key = p_order_id
    limit 1;
  if not found then
    -- already unbound / never bound → idempotent no-op, no restock
    unbound := false; item_id := null; restocked_lines := 0; restocked_units := 0; return next; return;
  end if;

  -- lock this item's SKUs (sorted) before touching shared stock — same discipline as the bind
  perform pg_advisory_xact_lock(hashtextextended('sku:'||sid::text, 0))
    from (select distinct inventory_sku_id sid from public.live_auction_item_skus
          where auction_item_id = v_item.id and user_id = v_user order by 1) z;

  for v_line in
    select inventory_sku_id, sum(qty)::int as qty, max(unit_cost_cents_snapshot) as cost
      from public.live_auction_item_skus
      where auction_item_id = v_item.id and user_id = v_user
      group by inventory_sku_id
  loop
    -- restore the on-hand count (always, even if the original cost is unknown)
    update public.inventory_skus set qty_on_hand = qty_on_hand + v_line.qty
      where id = v_line.inventory_sku_id and org_id = v_org;
    -- add a fresh FIFO layer at the snapshot cost (tail of the sequence) when the cost is known.
    -- external_ref is per (order, sku) so multi-SKU orders don't collide on uq_sku_batches_source_ref.
    if v_line.cost is not null then
      select coalesce(max(sequence), 0) + 1 into v_seq
        from public.sku_batches where sku_id = v_line.inventory_sku_id and org_id = v_org;
      insert into public.sku_batches
        (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence, source, external_ref)
      values
        (v_user, v_org, v_line.inventory_sku_id, v_line.qty, v_line.qty, v_line.cost, v_seq, 'unbind_restock', p_order_id || ':' || v_line.inventory_sku_id::text || ':' || v_item.id::text);
    end if;
    v_n := v_n + 1; v_u := v_u + v_line.qty;
  end loop;

  delete from public.live_auction_item_skus where auction_item_id = v_item.id and user_id = v_user;
  delete from public.live_auction_items     where id = v_item.id and user_id = v_user;

  raise notice 'lensed_unbind_as: user=% order=% item=% lines=% units=%', v_user, p_order_id, v_item.id, v_n, v_u;
  unbound := true; item_id := v_item.id; restocked_lines := v_n; restocked_units := v_u; return next;
end;
$function$;

-- service_role ONLY — trusts p_owner_user_id (same posture as lensed_log_auction_as in 084).
revoke execute on function public.lensed_unbind_as(uuid, text) from public, anon, authenticated;
grant  execute on function public.lensed_unbind_as(uuid, text) to service_role;

comment on function public.lensed_unbind_as(uuid, text) is
  'Service-role sibling of lensed_unbind: owner passed explicitly instead of auth.uid(). '
  'Restock layer external_ref is per (order, sku, item_id) so a re-corrected order cannot collide '
  'on uq_sku_batches_source_ref. lensed_unbind is unchanged and stays the extension/owner path.';

commit;
