-- 037_fulfillment_queue.sql
-- Orders-to-Complete queue support. ADDITIVE columns + an RLS re-scope.
--
-- (1) Deadline/label fields on fulfillment_orders (ship_by = rts_sla_time, etc).
-- (2) RLS owner -> org on fulfillment_orders + fulfillment_lines: fulfillment is a
--     SHARED-WAREHOUSE activity (any picker/packer in the org sees all boxes from both
--     stores). owner_user_id stays for attribution; store label comes from store_id.
--     P&L, financials, live captures, store operations REMAIN owner/store-private
--     (their tables are untouched). The DB cubicle lock (uniq_cubicle_active) stays.
--
-- Transaction-wrapped + idempotent (safe to re-run).

begin;

-- (1) deadline / label fields
alter table public.fulfillment_orders add column if not exists ship_by timestamptz;            -- rts_sla_time (late-dispatch deadline)
alter table public.fulfillment_orders add column if not exists ordered_at timestamptz;          -- create_time (age)
alter table public.fulfillment_orders add column if not exists label_status text not null default 'none'
  check (label_status in ('none','stub','purchased'));
alter table public.fulfillment_orders add column if not exists labels_purchased_at timestamptz;
create index if not exists idx_fo_ship_by on public.fulfillment_orders(ship_by);

-- (2a) fulfillment_orders RLS: owner -> org
drop policy if exists "owner read fo"   on public.fulfillment_orders;
drop policy if exists "owner insert fo" on public.fulfillment_orders;
drop policy if exists "owner update fo" on public.fulfillment_orders;
drop policy if exists "owner delete fo" on public.fulfillment_orders;
drop policy if exists "org read fo"   on public.fulfillment_orders;
drop policy if exists "org insert fo" on public.fulfillment_orders;
drop policy if exists "org update fo" on public.fulfillment_orders;
drop policy if exists "org delete fo" on public.fulfillment_orders;
create policy "org read fo"   on public.fulfillment_orders for select using (public.is_org_member(org_id));
create policy "org insert fo" on public.fulfillment_orders for insert with check (public.is_org_member(org_id));
create policy "org update fo" on public.fulfillment_orders for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy "org delete fo" on public.fulfillment_orders for delete using (public.is_org_member(org_id));

-- (2b) fulfillment_lines RLS: owner -> org (via parent box's org_id; lines have no org_id)
drop policy if exists "owner read fl"   on public.fulfillment_lines;
drop policy if exists "owner insert fl" on public.fulfillment_lines;
drop policy if exists "owner update fl" on public.fulfillment_lines;
drop policy if exists "owner delete fl" on public.fulfillment_lines;
drop policy if exists "org read fl"   on public.fulfillment_lines;
drop policy if exists "org insert fl" on public.fulfillment_lines;
drop policy if exists "org update fl" on public.fulfillment_lines;
drop policy if exists "org delete fl" on public.fulfillment_lines;
create policy "org read fl" on public.fulfillment_lines for select
  using (exists (select 1 from public.fulfillment_orders fo where fo.id = fulfillment_lines.fulfillment_order_id and public.is_org_member(fo.org_id)));
create policy "org insert fl" on public.fulfillment_lines for insert
  with check (exists (select 1 from public.fulfillment_orders fo where fo.id = fulfillment_lines.fulfillment_order_id and public.is_org_member(fo.org_id)));
create policy "org update fl" on public.fulfillment_lines for update
  using (exists (select 1 from public.fulfillment_orders fo where fo.id = fulfillment_lines.fulfillment_order_id and public.is_org_member(fo.org_id)))
  with check (exists (select 1 from public.fulfillment_orders fo where fo.id = fulfillment_lines.fulfillment_order_id and public.is_org_member(fo.org_id)));
create policy "org delete fl" on public.fulfillment_lines for delete
  using (exists (select 1 from public.fulfillment_orders fo where fo.id = fulfillment_lines.fulfillment_order_id and public.is_org_member(fo.org_id)));

commit;
