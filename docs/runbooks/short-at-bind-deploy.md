# Deploy runbook — `short_at_bind` / OUT OF STOCK band

**Branch:** `feat/confirm-host-live-hours` → `main`
**Written:** 2026-08-17. Nothing in this chain was applied or deployed at the time of writing.

Follow this top to bottom. It is self-contained — you should not need to read
the conversation that produced it.

---

## What the feature does

A host sells a SKU during a live that is already at zero. Nothing stops the
sale. The order arrives unbound, the team binds it after, and the bind draws
stock that isn't there. **That** is the moment the system knows the order can't
be filled — hours before anyone buys a label. This chain records it at that
moment (`live_auction_item_skus.short_at_bind`) so the pick screen is a pure
read: a dimmed image and a red **OUT OF STOCK** band on the affected box only.

Per **order line**, not per SKU. Sell 10 with 8 on hand: the first 8 orders bind
fine and only the last 2 are short, so only those 2 boxes warn.

---

## Three artifacts, three steps

| Step | Artifact | Gated by |
|---|---|---|
| 1 | migration `104` — the column | write-silence |
| 2 | app deploy (merge to `main`) | **step 1 complete** (hard gate) |
| 3 | migration `105` — both bind RPCs | write-silence (re-check) |

**Do not reorder steps 1 and 2.** Step 3 may be done any time after step 1;
doing it after step 2 is recommended so the reader change is proven safe before
the bind path changes.

---

## Before you start — write-activity silence

Steps 1 and 3 touch capture-path objects. Both are gated. Check and record:

```sql
select max(created_at) as last_capture from capture_events;
select max(last_seen_at) as last_session_beat from live_sessions;
```

Both must be **more than ~15 minutes stale**.

Do **not** use `live_sessions.status = 'live'` as the interlock — it is
unreliable and must never be a safety gate. Weekends are not automatically
quiet; shows run on Sundays.

---

## STEP 1 — Apply migration 104 (the column)

    supabase/migrations/104_auction_line_short_at_bind.sql

`ALTER TABLE live_auction_item_skus ADD COLUMN short_at_bind boolean` plus a
column comment. Nullable, no default, no backfill, no index, no RLS change.
**Completely inert** — nothing reads or writes it until step 3.

`ADD COLUMN` with no default is catalog-only (no table rewrite), but it takes a
brief `ACCESS EXCLUSIVE` lock and will queue behind an in-flight bind. That is
why it is gated despite being inert.

**Verify before moving on:**

```sql
select column_name from information_schema.columns
where table_name = 'live_auction_item_skus' and column_name = 'short_at_bind';
```

Must return exactly one row.

> **If it does not, STOP. Do not proceed to step 2.**

---

## STEP 2 — Deploy the app (merge to `main`)

> ## ⛔ HARD GATE — step 1 must be verified complete first
>
> The deployed readers issue `select … short_at_bind` against
> `live_auction_item_skus`. **PostgREST returns HTTP 400 for a column that does
> not exist.** Deploying this without the column **breaks every box scan on both
> the Shipping tab and the station** — pickers cannot load a single box. This is
> not a missing band; it is a dead pick flow during fulfilment.
>
> There is no partial failure mode and no graceful degradation. Check the column
> exists, then deploy.

Not write-silence gated — additive application code (CLAUDE.md deploy risk
classes). Deploy, smoke-test, keep rollback ready.

**Expected behaviour: no visible change.** Every `short_at_bind` is still null,
so `shelf_out` is false everywhere and the band never renders. That is correct
and is what proves step 2 is safe on its own.

### Smoke test — in this order

1. **Scan a box on the Shipping tab.** It must load normally.
   *This is the 400-risk check. Do it first.*
2. **Scan a box on the station** (`/fulfillment`). Same.
3. Confirm there is **no** "Can't find it" button on the pick card, and that
   Grab one / ‹ Back / Next › / Finish box all still work.
4. Complete one box; confirm a row lands in `shipment_verifications`.
5. **Claim a shift from a `/s/<token>` link.** Commit `aa99b004` added owner
   scoping to `claimShift`, so exercise it once — one successful claim and one
   refusal (claiming your own release gives `OWN_RELEASE`).

### Rollback

Revert the merge commit, or promote the previous Vercel deployment. Safe at any
point. The column can stay — it is inert without the app.

---

## STEP 3 — Apply migration 105 (both bind RPCs)

    supabase/migrations/105_bind_records_short_at_bind.sql

> **Write-silence gated. Re-check silence now — do not rely on the step 1
> check.** This replaces the two functions the capture extension calls directly
> via PostgREST during shows. `lensed_log_auction` is the extension's path;
> `lensed_log_auction_as` is member/retroactive bind.

Contains two complete `CREATE OR REPLACE FUNCTION` bodies, built from live
`pg_get_functiondef()` output, plus a grant/revoke restatement that is a no-op.
`CREATE OR REPLACE` preserves the existing ACL — **no permissions change.**

The change is six lines per function and adds **no new statement**: the flag
rides an `UPDATE` and an `INSERT … SELECT` that already run on the bind path.
A bind cannot fail or slow down because of it.

### Verify after applying

```sql
-- both functions must now carry the flag
select proname from pg_proc
where proname in ('lensed_log_auction','lensed_log_auction_as')
  and prosrc like '%short_at_bind%';
-- expect 2 rows

-- grants unchanged
select has_function_privilege('authenticated', oid, 'EXECUTE')
from pg_proc where proname = 'lensed_log_auction';
-- expect true
```

**Then, before the next show:** bind one test order for an **in-stock** SKU and
confirm its line records `short_at_bind = false` (not null). That proves the
write path is live, without needing a real oversell.

### Rollback — the pre-change definitions are committed

    docs/runbooks/short-at-bind-rollback/lensed_log_auction.pre-105.sql
    docs/runbooks/short-at-bind-rollback/lensed_log_auction_as.pre-105.sql

Each is the exact live `pg_get_functiondef()` output from before 105, with a
terminating semicolon appended so it runs as-is. Neither mentions
`short_at_bind`. Run both to restore the previous bodies.

Rolling back 105 does **not** require rolling back the column or the app — with
105 reverted, new binds stop setting the flag, already-set rows keep theirs, and
the band keeps working for those.

---

## STEP 4 — Verify the TRUE case end to end (after step 3)

The scenario this feature exists for: **a host sells an item without scanning
it. After the live, the team binds the SKU, and the bind goes negative because
the unit was already gone. The picker later scans that label and must see OUT OF
STOCK before walking to the rack.**

### 4.0 — You do not need to fabricate anything

As of 2026-08-17 there are **at least 12 active SKUs already at or below zero**,
several hundred units short in aggregate. Any bind of an unbound order for one
of those SKUs goes through the `allow_negative` path automatically — the FIFO
lookup finds no layer holding the qty, which is exactly the condition that sets
the flag. Do **not** hand-edit `qty_on_hand` or `sku_batches` to force it; that
is a capture-path write and it is not necessary.

> **Expectation to set before you look at the results.** Because those SKUs are
> already deeply negative, *every* new bind against one of them will be flagged,
> not only the single unit that ran out. That is consistent with the design — the
> line genuinely could not be drawn from recorded stock — but the band will not
> be rare. It also means: if someone restocked physically without recording it,
> the flag still fires. The flag's claim is "the system had no stock for this
> line", and that is precisely what the picker is being warned about.

### 4.1 — Pick a safe SKU

Prefer a negative SKU with the **fewest open pick orders**, so a mistake touches
as little live fulfilment as possible.

```sql
select s.id, s.sku_number, s.title, s.qty_on_hand,
       coalesce((select sum(b.qty_remaining) from sku_batches b where b.sku_id = s.id),0) as batch_remaining,
       (select count(*) from live_auction_item_skus l
          join live_auction_items ai on ai.id = l.auction_item_id
          join synced_order_ids o on o.order_id = ai.client_idempotency_key
        where l.inventory_sku_id = s.id and o.status = 'AWAITING_COLLECTION') as open_pick_orders
from inventory_skus s
where s.is_active and s.qty_on_hand <= 0
order by open_pick_orders asc, s.qty_on_hand asc
limit 10;
```

Choose a row with **low `open_pick_orders`** and `batch_remaining <= 0`. Record
the `sku_number` and `id`.

### 4.2 — Find a genuinely unbound order for that SKU

The cleanest test is a bind the team **should be doing anyway** — a real
captured-but-unbound order whose SKU is one of the negative ones. No synthetic
data, and the bind is correct rather than a fabrication.

```sql
-- captured but never bound (no live_auction_items row for the order key)
select c.order_id, c.product_name, c.platform_sku_ref, c.created_at, o.status
from capture_events c
left join live_auction_items ai on ai.client_idempotency_key = c.order_id
left join synced_order_ids o on o.order_id = c.order_id
where ai.id is null
order by c.created_at desc
limit 25;
```

Pick one whose product plainly corresponds to your chosen SKU. **If none
matches, stop and wait** — do not bind an order to a SKU it does not contain
just to exercise the test. A wrong bind is real inventory and real P&L damage,
and it is worse than an unverified feature.

### 4.3 — Bind it through the real post-live path

Use the surface the team actually uses after a show:

**`/team/binding` (the member binding queue)**
1. Select the session the order belongs to.
2. Expand the order row.
3. Set the SKU line(s) to your chosen SKU, qty as sold.
4. Press **Bind** — the primary action, which sends `allow_negative: false`.
5. It will fail with **409 "Out of stock for that SKU"**. That is the expected
   first result and is the whole point: negative stock is never the first action.
6. The **"Bind anyway"** control now appears. Press it. This reposts with
   `allow_negative: true`, which is the path that sets the flag.

That route is `POST /api/member/bind` → **`lensed_log_auction_as`**.

**To also cover the other patched function**, repeat once from the operator
side: **Shows tab → expand an unbound row → bind → confirm the negative-stock
dialog**. That is `POST /api/live/sessions/[id]/bind` →
**`lensed_log_auction`**, which is the function the capture extension calls.
Migration 105 patched both; one test each proves both.

### 4.4 — Confirm the flag landed on that specific line

```sql
select ai.client_idempotency_key as order_id,
       l.sku_number_snapshot, l.qty, l.short_at_bind, l.created_at
from live_auction_item_skus l
join live_auction_items ai on ai.id = l.auction_item_id
where ai.client_idempotency_key = '<THE ORDER ID>';
```

`short_at_bind` must be **`true`** — not null, not false.

- **null** → migration 105 is not applied (or you bound before applying it).
- **false** → the bind found stock in some FIFO layer, so this order was not
  short. Pick a different SKU, or check `batch_remaining` again.

Sanity-check the negative case too: bind one order for an **in-stock** SKU and
confirm it records **`false`**. A feature that flags everything is as useless as
one that flags nothing.

### 4.5 — Scan it on both surfaces

**You do not need to buy a label.** The scan input accepts a **bare TikTok order
id** as well as a shipping label — `pick-list` resolves digits directly against
`synced_order_ids.order_id`.

Getting the value into the field, in order of convenience:

- **Hardware scanner** (the real path) — scan the actual shipping label if the
  order already has one.
- **Bluetooth keyboard** — type the order id and press Enter. The hidden input is
  always focused.
- **Barcode on a second screen** — render the order id as Code-128 and scan it.

The overlay's input is deliberately `inputMode="none"`, so **a phone will not
raise an on-screen keyboard.** Plan for a scanner or an external keyboard; you
cannot simply tap and type.

Do this on **both**:
1. **Shipping tab → Start scanning** (operator path, `/api/shipping/pick-list`).
2. **`/fulfillment`** (station path, `/api/station/scan` → `assembleBox`).

They are separate implementations of the same logic. The band must appear on
both. If it appears on one only, one reader did not get the change.

Expected on the card: the item photo dimmed to ~30%, a red band across the
middle reading **OUT OF STOCK**, and — critically — **Grab one still works**,
Back / Next still navigate, and the box can still be completed. The band informs;
it never blocks.

### 4.6 — Clean up

> ## ⚠️ Do NOT press "Finish box" on a test box
>
> Completing a box writes an **immutable** `shipment_verifications` row —
> `ON CONFLICT (user_id, group_key) DO NOTHING`, so a re-confirm is a silent
> no-op and **cannot be corrected by re-running it.** It is attributed to the
> selected picker and feeds Average Pick Time, Active Picking Time and
> orders-per-hour. A test box completed by you pollutes a real person's KPIs
> permanently.
>
> To leave the card without recording anything: **hold the ✕ (hold-to-exit ~0.9s)**,
> or press **New label** and choose **Discard & continue**.

**Note what cleanup does and does not cover:**

- **The pick queue is driven by TikTok status, not by bind state or
  verification.** `pick-tickets` selects `synced_order_ids.status =
  'AWAITING_COLLECTION'` and does **not** filter out verified boxes. So the test
  order was already in the queue before you touched it, binding did not add it,
  and completing it would not remove it. It leaves the queue when it genuinely
  ships. There is nothing to clean up there.
- **If the bind was correct**, leave it. It is real work the team owed anyway,
  and the flag on it is true.
- **If you bound the wrong SKU**, reverse it:
  `POST /api/live/sessions/<session_id>/unbind { "order_id": "<order id>" }`
  (Shows tab exposes this as **Unbind** on the row.) `lensed_unbind` restocks the
  qty as a **fresh FIFO layer** at the snapshot cost and deletes the
  `live_auction_items` / `_skus` rows — which also removes the `short_at_bind`
  row. Caveat: it does not restore the original batch layout, it adds a new
  layer. It is the sanctioned correction, not a byte-exact undo.
- **If you did complete a test box by mistake**, the only remedy is deleting that
  row by hand:
  ```sql
  -- inspect first; group_key is the combine-group id or 'order:<order_id>'
  select * from shipment_verifications where group_key = '<group_key>';
  ```
  `shipment_verifications` is a fulfilment-side table, **not** on the capture or
  order-sync path, so this delete is not write-silence gated. Confirm the row is
  yours and is the test before removing it.

### 4.7 — What to check on the phone, in the warehouse

The band and the dimming were specified but have never been seen on a real
device under real light. Look at these deliberately, standing where a picker
stands:

- **Is the band legible in warehouse lighting?** It is `red-800` at 95% opacity
  with `red-50` text at **15px, medium weight**. 15px is small for an
  arm's-length glance under overhead light — check it from where the phone
  actually sits, not held up close.
- **Is the 30%-opacity photo still recognisable enough to match against a
  shelf?** This is the real tension in the design: the dimming must say "stop"
  without destroying the picker's ability to identify the item. If the photo is
  unusable at 30%, raise the opacity (say 45–50%) rather than removing the band.
- **Does the band cover the part of the photo that identifies the item?** It sits
  vertically centred and inset 12px each side. On a tall product shot the middle
  may be the only distinguishing region.
- **Glare and angle.** Red-on-red at 95% can flatten under direct light or on a
  screen tilted away.
- **Is it obvious the item is still grabbable?** The green Grab one button is
  unchanged directly below a big red warning. Confirm that reads as "warning",
  not "disabled" — if pickers hesitate, the copy or layout needs work, not the
  logic.

Note anything off and treat it as a follow-up commit against the overlay. None
of it requires touching the migrations, the bind path, or either reader — the
band is presentation only.

### 4.8 — Ongoing: what has been flagged

```sql
select ai.client_idempotency_key as order_id, l.sku_number_snapshot, l.qty,
       l.short_at_bind, l.created_at
from live_auction_item_skus l
join live_auction_items ai on ai.id = l.auction_item_id
where l.short_at_bind is true
order by l.created_at desc
limit 20;
```

---

## What this chain deliberately does NOT do

- **No backfill.** Orders bound short before step 3 stay null and show no band.
  Flagging history would be a separate, deliberate job — and it is **not**
  reconstructible from `qty_on_hand` after the fact.
- **No clearing, no expiry, no time window.** An order either was short at bind
  or it wasn't, and that never changes. Restocking later does not clear it.
- **No `qty_on_hand` derivation.** That counter is global (it cannot say whether
  *this* order's units were the short ones) and it isn't even the number the bind
  decides on — `OUT_OF_STOCK` is evaluated against `sku_batches.qty_remaining`,
  the FIFO layers.
- **Migration 102 never existed on live.** An earlier picker-reported design
  (`sku_shelf_flags`) was deleted unapplied, not superseded. Nothing to undo.

---

## Pre-merge check on the rest of the branch

`main..HEAD` is **fifteen** commits, not eleven. Merging carries four
pre-existing shift/confirm commits and three migrations that arrive in the diff
but are **not** part of this chain: `098`, `099`, `103`.

**Applied-state verified against live on 2026-08-17 — all three are APPLIED.
Merging brings no unplanned DDL.**

| Migration | Object checked | Live |
|---|---|---|
| `098_employee_photos` | `employees.photo_path` column | ✅ present |
| `098_employee_photos` | `storage.objects` `employee-photos*` policies | ✅ 4 present |
| `099_qr_clock_in` | `clock_codes` table | ✅ present |
| `099_qr_clock_in` | `clock_audit` table | ✅ present |
| `099_qr_clock_in` | `clock_purpose` enum type | ✅ present |
| `099_qr_clock_in` | `lensed_kiosk_manual_punch_as()` | ✅ present |
| `099_qr_clock_in` | `employee_time_entries.punch_method` column | ✅ present |
| `103_platform_fee_centralization` | `platform_fee_cents()` | ✅ present (that commit was a renumber only) |

Re-run the check if significant time passes before you merge:
`docs/runbooks/short-at-bind-rollback/` has no query for this, but the table
above lists every object — one `information_schema` / `pg_proc` lookup each.

---

## Commits in this chain

```
f42020cf  fix(pick): cancel the 550ms line-complete timer on abandon/reload/unmount
1fb3cff5  chore(migrations): renumber platform-fee centralization 099 -> 103
2fbc6859  feat(pick): picker-reported OUT OF STOCK band          ← superseded by 26415229
2be960be  fix(kiosk): restore rate limiters lost in working-tree destruction
b6581de4  fix(labor): resolve the period window through the LA zone, not a fixed -07:00
aa99b004  feat(schedule): harden claimShift's race guard + owner scope, with tests
26415229  refactor(pick): drop picker-reported shelf flags, keep the band
70d600a7  migration 104: live_auction_item_skus.short_at_bind
b80e60ea  migration 105: bind records short_at_bind in both RPCs
0a894150  feat(pick): surface short_at_bind as the OUT OF STOCK band
35f742a4  chore(ci): register lensed_log_auction_as as service-role-only
```

`2fbc6859` and `26415229` are an add-then-remove pair kept as history rather
than squashed: the first shipped a picker-reported model, the second removed its
entire write path while keeping the visual. The band's markup is byte-identical
across both.

## Also note

The kiosk / badges / labor work is **uncommitted** in the working tree, so it
does not deploy with step 2. Consequently `src/lib/rate-limit.ts`'s four
restored limiter exports (`kioskIpLimiter`, `kioskBadgeLimiter`,
`kioskSupervisorIpLimiter`, `clockCodeLimiter`) are unused in the built
bundle — harmless, and expected.

Three of those four limit values are reconstructed judgement, not recovered
originals (`clockCodeLimiter` was recovered exactly from its call-site comment).
See `2be960be` for the reasoning if you want to retune them.
