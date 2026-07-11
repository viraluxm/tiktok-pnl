# Recovery: unbound live orders → correct COGS / inventory / P&L

**Status:** DRAFT. Read-only audit + script. Nothing here has been run. Do not
write to production until the mapping (order → inventory_skus.id) is confirmed.

---

## A. Which path P&L / COGS / inventory actually read from — CONFIRMED

Binding `capture_events.bound_sku_id` alone is **NOT enough**. Proof, from
`supabase/migrations/039_pnl_aggregation_functions.sql`:

- Revenue + sale date come from `capture_events`, but they are joined in ONLY via
  `capture_events.order_id = live_auction_items.client_idempotency_key`
  (039:73-75, 162-163, 222-223, 276-277).
- COGS comes from `live_auction_item_skus.unit_cost_cents_snapshot`
  (039:86, 173, 234, 287).
- The join requires `live_auction_items.status = 'sold'` (039:76).
- `bound_sku_id` is referenced **nowhere** in the P&L functions (grep = 0 hits).

**Consequence:** a `capture_events` row with no matching `live_auction_items` row
(client_idempotency_key = its order_id) is invisible to P&L — it contributes
neither revenue nor COGS, and inventory is never decremented. Setting
`bound_sku_id` is at most cosmetic for a live-orders list; it does not fix P&L,
COGS, or on-hand stock.

Inventory / FIFO lives entirely in `lensed_log_auction` (current prod def = **043**,
which supersedes 035b/041):
- Draws FIFO from `sku_batches` (oldest `sequence` with enough `qty_remaining`),
  decrements `sku_batches.qty_remaining` and `inventory_skus.qty_on_hand`
  (043:227-228 replay path, 285-286 insert path).
- Snapshots cost into `live_auction_item_skus.unit_cost_cents_snapshot`.

**Therefore the correct recovery is to replay each unbound order through
`lensed_log_auction`** — which creates the missing `live_auction_items` row (with
`client_idempotency_key = order_id`), snapshots COGS, and decrements FIFO. The
existing `capture_events` row (revenue, already upserted) then joins to it
automatically and appears in P&L.

### Idempotency / safety — verified in the RPC body (043)
- Unique index `idx_live_auction_items_user_idem` on
  `(user_id, client_idempotency_key)` where key is not null (043:166-168).
- The RPC looks up an existing row by `(user_id, p_idem_key)` **across any
  session** (043:203-207). If found → REPLAY, `replayed=true`, **no second row,
  no second FIFO draw** (043:255-259). New-insert path is wrapped in a
  `unique_violation` handler that rolls back its FIFO draws and replays on a race
  (043:314-325).
- => Re-running with `p_idem_key = order_id` is inherently safe to re-run,
  cannot double-decrement, cannot create duplicate auction rows.

### There is ALREADY a production endpoint for this
`src/app/api/live/sessions/[id]/bind/route.ts` — "retroactive manual bind": POST
`{ order_id, lines: [{sku_id, qty}], allow_negative? }`, runs as the authenticated
host, sets `p_manual=true` on ended/reconciled sessions, and reuses
`lensed_log_auction`. **This is the recovery mechanism — prefer it over raw SQL**
because the RPC is `security invoker` / `auth.uid()`-scoped: a service-role SQL
run has `auth.uid() = null` and raises `NOT_AUTHENTICATED` / `NO_ORG`.

---

## B. Recovery procedure (DRAFT — do not run yet)

### Step 1 — List unbound captured orders for the live (READ-ONLY)

An order is "unbound" when its `capture_events` row has no matching sold
`live_auction_items` row. `bound_sku_id is null` is a weaker proxy; use the join
so we catch cases where the two disagree.

```sql
-- Run as the host (RLS scopes to their user_id), or add: where ce.user_id = '<HOST_USER_ID>'
select
  ce.order_id,
  ce.buyer_username,
  ce.product_name,
  ce.platform_sku_ref,
  ce.tiktok_sku_id,
  ce.selling_price_cents,
  ce.ordered_at,
  ce.room_id,
  ce.bound_sku_id
from capture_events ce
left join live_auction_items lai
  on lai.client_idempotency_key = ce.order_id
 and lai.user_id = ce.user_id
where lai.id is null                         -- no auction row => invisible to P&L
  and ce.ordered_at >= '2026-07-09'          -- today's live; tighten to the session window
order by ce.ordered_at;
```

To get the SESSION id to bind against (bind endpoint needs it in the URL):

```sql
select id, status, started_at, ended_at, room_id
from live_sessions
where user_id = '<HOST_USER_ID>'
  and started_at >= '2026-07-09'
order by started_at desc;
```

### Step 2 — Build the mapping (MANUAL, human-confirmed)

For each `order_id`, decide the correct `inventory_skus.id` and qty using
`product_name` / `platform_sku_ref` / `tiktok_sku_id`. Candidate lookup:

```sql
select id, sku_number, barcode, title, qty_on_hand, unit_cost_cents
from inventory_skus
where is_active
  and ( title ilike '%<keyword>%' or barcode = '<platform_sku_ref>' )
order by sku_number;
```

Fill in this map (one row per order; multiple lines allowed for bundles):

```
order_id            -> [{ sku_id, qty }]
19xxxxxxxxxxxxxxxx  -> [{ sku_id: '....', qty: 1 }]
```

### Step 3 — DRY-RUN preview (READ-ONLY, no writes)

Confirms each planned bind resolves to a real SKU, shows the FIFO cost that WOULD
be drawn and whether it would go out of stock — without touching anything.

```sql
-- :mapping is your Step-2 list as JSON, e.g.
--   [{"order_id":"19..","sku_id":"aaaa..","qty":1}, ...]
with plan as (
  select (x->>'order_id') as order_id,
         (x->>'sku_id')::uuid as sku_id,
         greatest(1, coalesce((x->>'qty')::int,1)) as qty
  from jsonb_array_elements(:mapping::jsonb) x
),
already as (   -- orders that ALREADY have an auction row (would REPLAY = no-op)
  select p.order_id
  from plan p
  join live_auction_items lai
    on lai.client_idempotency_key = p.order_id and lai.user_id = auth.uid()
)
select
  p.order_id,
  case when a.order_id is not null then 'ALREADY BOUND — would replay (no-op)'
       else 'WILL BIND' end                                as action,
  isk.sku_number, isk.title, p.qty,
  isk.qty_on_hand                                          as on_hand_now,
  -- oldest FIFO batch that could satisfy p.qty:
  b.id                                                     as fifo_batch_id,
  b.unit_cost_cents                                        as fifo_unit_cost_cents,
  (b.unit_cost_cents * p.qty)                              as line_cogs_cents,
  case when b.id is null then 'OUT_OF_STOCK (needs allow_negative)' else 'ok' end as stock
from plan p
left join already a on a.order_id = p.order_id
left join inventory_skus isk on isk.id = p.sku_id and isk.org_id = current_user_org()
left join lateral (
  select id, unit_cost_cents from sku_batches
  where sku_id = p.sku_id and org_id = current_user_org() and qty_remaining >= p.qty
  order by sequence asc limit 1
) b on true
order by p.order_id;
```

Review this output. Investigate anything showing `SKU_NOT_FOUND` (null sku_number)
or `OUT_OF_STOCK` before proceeding.

### Step 4 — Execute the bind (WRITE — only after Step 3 looks right)

**Preferred: drive the existing production endpoint per order** (runs as host,
idempotent, correct auth/org context). Session cookie must belong to the host.

```bash
# One call per order. Re-running is safe (RPC replays on dup order_id).
curl -sS -X POST "$BASE/api/live/sessions/$SESSION_ID/bind" \
  -H 'content-type: application/json' \
  -H "cookie: $HOST_SESSION_COOKIE" \
  -d '{"order_id":"19XXXXXXXXXXXXXXXX","lines":[{"sku_id":"aaaa-...","qty":1}]}'
# add "allow_negative": true ONLY for a confirmed sale against under-counted stock
```

Response `{"ok":true,"already_bound":true}` or `{"replayed":true}` = the order was
already bound; nothing changed. `{"ok":true,"replayed":false,"status":"sold"}` =
newly bound, FIFO drawn once.

**Raw-SQL alternative** (only if you cannot use the endpoint) — MUST run inside the
host's authenticated context so `auth.uid()`/`current_user_org()` resolve; a plain
service-role connection will raise `NOT_AUTHENTICATED`:

```sql
-- inside a transaction, impersonating the host:
set local role authenticated;
set local request.jwt.claims = '{"sub":"<HOST_USER_ID>"}';

select * from lensed_log_auction(
  '<SESSION_ID>'::uuid,           -- p_session_id
  'sold',                         -- p_result
  '[{"sku_id":"aaaa-...","qty":1}]'::jsonb,  -- p_skus
  '19XXXXXXXXXXXXXXXX',           -- p_idem_key = TikTok order_id  (idempotency key!)
  true,                           -- p_manual (session likely ended)
  false                           -- p_allow_negative
);
```

`p_idem_key` MUST be the TikTok `order_id` — that is what makes the replay
idempotent and what the P&L join keys on. Do not pass a random value.

### Step 5 — Verify (READ-ONLY)

```sql
-- Should now return 0 rows (all recovered):  [rerun Step 1 query]
-- Spot-check P&L sees them:
select lai.client_idempotency_key as order_id, lai.status,
       sum(las.qty*coalesce(las.unit_cost_cents_snapshot,0)) as cogs_cents,
       ce.selling_price_cents
from live_auction_items lai
join capture_events ce on ce.order_id = lai.client_idempotency_key and ce.user_id = lai.user_id
join live_auction_item_skus las on las.auction_item_id = lai.id
where lai.client_idempotency_key = any(:order_ids)
group by 1,2, ce.selling_price_cents;
```

---

## Notes / caveats
- `capture_events.bound_sku_id` is NOT updated by `lensed_log_auction` and is not
  needed for P&L. Update it separately only if a live-orders UI reads it (cosmetic).
- Inventory has moved on since the live. FIFO draw uses TODAY's oldest batch, which
  is normally correct, but if batches were added/settled after the live the drawn
  cost may differ from the true sale-moment cost. Verify in Step 3.
- Do NOT loosen `allow_negative` globally. Set it per-order only for confirmed sales
  against under-counted stock.

---

## Operational worksheets

The per-order reconciliation worksheets used during this recovery (host-review
sheets, unbound-order lists, and the move/recovery plans, in CSV/XLSX form) are
**operational data, not source**, and are archived **outside the repository**. They
are point-in-time analysis artifacts and are intentionally not tracked in Git. This
document captures the durable method; the worksheets capture one run of it.
