-- Ledger for purchased shipping labels.
--
-- WHY A LEDGER AT ALL. TikTok's Create Packages call BUYS the label — tested on Snore
-- 2026-09-03: one call moved an order AWAITING_SHIPMENT -> AWAITING_COLLECTION, issued a
-- tracking number and made the document downloadable, with no Ship call. There is no quote
-- step and no cancel. So a run that dies halfway through must never re-buy what it already
-- bought, and the only way to know what it bought is to have written it down BEFORE calling.
--
-- HOW THE DOUBLE-BUY GUARD WORKS. The unique index below is the guard, not application code.
-- A run INSERTs a 'claimed' row for a box first; a conflict means another run (or an earlier
-- crash of this one) already owns that box, so this run skips it. Only after the insert
-- succeeds does the API call go out. A process killed between the insert and the call leaves a
-- 'claimed' row that blocks re-purchase until a human resolves it — deliberately the safe
-- direction: a stuck box costs one manual look, a double-buy costs money and confuses the
-- carrier with two labels for one package.
--
-- 'failed' rows are excluded from the index so a genuine failure can be retried. 'purchased'
-- rows can therefore never be re-bought by any code path. If a real re-label is ever needed
-- (TikTok does re-label combine shipments) that is a deliberate manual DELETE, not something a
-- job may decide on its own.

create table if not exists shipping_label_purchases (
  id uuid primary key default gen_random_uuid(),

  user_id  uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null,

  -- Groups every box bought by one invocation, so a run can be reviewed or reversed as a unit.
  run_id uuid not null,

  -- The box. Mirrors the planner's group_key: an auto_combine_group_id, or "order:<id>" for an
  -- order standing alone. Text because both shapes are text and the fallback is synthetic.
  group_key text not null,
  -- Every order in the box. One label covers all of them.
  order_ids text[] not null,

  -- claimed  : row written, API call not yet known to have succeeded
  -- purchased: TikTok returned a package_id — the label EXISTS and money is spent
  -- failed   : TikTok rejected it and no label was created; safe to retry
  status text not null default 'claimed'
    check (status in ('claimed', 'purchased', 'failed')),

  -- ship_type sent to TikTok: '1' one order in one package, '3' several orders in one package.
  ship_type text check (ship_type in ('1', '3')),

  package_id      text,
  tracking_number text,

  -- What it cost. Recorded per box because the price is only knowable after buying: there is
  -- no endpoint that quotes without purchasing.
  price_amount   numeric(10,2),
  price_currency text,
  shipping_provider_name text,
  shipping_service_name  text,

  -- The label PDF. `doc_url` is short-lived (~24h), so it is a convenience only — package_id
  -- is the durable handle and the document can always be re-fetched with it.
  doc_url            text,
  doc_url_expires_at timestamptz,
  -- Set when the label was bought but its document could not be fetched. NEVER a reason to
  -- mark the row 'failed': the label exists, and 'failed' would invite a re-purchase.
  doc_error text,

  error_code    text,
  error_message text,

  claimed_at   timestamptz not null default now(),
  purchased_at timestamptz,

  created_at timestamptz not null default now()
);

-- THE guard. One live claim per box per store; 'failed' excluded so retries are possible.
create unique index if not exists shipping_label_purchases_box_uniq
  on shipping_label_purchases (user_id, store_id, group_key)
  where status <> 'failed';

-- Reviewing a run, and totalling its spend.
create index if not exists shipping_label_purchases_run_idx
  on shipping_label_purchases (run_id);

-- "was this order's label already bought?" without scanning the table.
create index if not exists shipping_label_purchases_orders_idx
  on shipping_label_purchases using gin (order_ids);

-- Finding rows stuck mid-purchase after a crash.
create index if not exists shipping_label_purchases_claimed_idx
  on shipping_label_purchases (user_id, store_id, claimed_at)
  where status = 'claimed';

alter table shipping_label_purchases enable row level security;

-- Own-row only. The purchase job runs service-role, which bypasses this; the policy exists so
-- a future authenticated read cannot see another tenant's spend.
drop policy if exists shipping_label_purchases_own on shipping_label_purchases;
create policy shipping_label_purchases_own on shipping_label_purchases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table shipping_label_purchases is
  'One row per box whose shipping label was bought (or attempted). Written BEFORE the TikTok '
  'Create Packages call, which is itself the purchase — see the unique index for the '
  'double-buy guard.';
