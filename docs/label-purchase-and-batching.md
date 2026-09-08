# Buying shipping labels through Lensed, and printing them in pick order

**Status:** design only — **nothing built, nothing bought.** Written 2026-09-03 after probing the
live TikTok API against a re-authorised shop. Everything under "Verified" was observed; everything
under "Open" is not yet known and must not be guessed at in code.

**This feature spends money.** A bug does not corrupt a row — it purchases hundreds of labels and
creates hundreds of shipments. That single fact drives most of the design below.

---

## 1. Why

Two problems, one fix.

**Buying labels is currently manual and rate-limited by a UI.** Seller Center caps the selection at
~600 auction-won SKUs, so a day's labels take several passes per shop, by hand.

**Picking is unbatched.** Measured over the 21 days to 2026-09-03, at the combine-group grain the
pick path already uses:

| Box shape | Count | Share |
|---|---|---|
| One SKU, one unit | **13,064** | **47.7%** |
| One SKU, several units | 439 | 1.6% |
| Multiple SKUs | 13,908 | 50.7% |
| **Total boxes** | **27,411** | |

Nearly half of all boxes are a single unit of a single SKU. Those are interchangeable: any label in a
same-SKU batch fits any unit of it, so there is no mismatch risk in batching them. The packer's loop
becomes mechanical — one item, one package, slap, next — with nothing to read or count.

**Buying the labels through Lensed is what makes the batching possible**, not a separate nicety.
Because Lensed requests each label itself, it knows which document belongs to which order, so
assembly is pure composition. The alternative — uploading a bought PDF and reordering its pages —
requires extracting a tracking number from each page to work out what it is, which breaks silently
whenever TikTok changes their label template. That path is rejected.

---

## 2. Verified against the live API

Probed 2026-09-03 against **Snore** after re-authorisation. Read-only and deliberately-invalid
requests only; nothing was created or purchased.

**The Fulfillment scope works, and re-authorisation was the fix.** `Fulfillment Basic`
(`seller.fulfillment.basic`) was toggled on in Partner Center, but all four shops had authorised
*before* it was enabled, and a token only carries the scopes granted at authorisation time.
`/logistics/202309/warehouses` returned `code 0` immediately after re-auth, having previously been
inaccessible. Partner Center states this outright: *"After applying a new scope, you need to inform
your clients of re-authorizing the service."*

> This very likely also explains the **Customer Service scope**, recorded in memory as an "app-side
> scope config gap" that "re-auth alone won't fix" after being approved 2026-06-04. Same mechanism.
> Worth retesting once the remaining shops are re-authorised.

**The flow is three calls per package.**

```
POST /fulfillment/202512/packages                          → returns package_id
POST /fulfillment/202309/packages/{id}/ship                → handover_method (string)
GET  /fulfillment/202309/packages/{id}/shipping_documents   → document_type=SHIPPING_LABEL
```

Note the versions differ per endpoint. `shipping_documents` does not exist on 202512 (*"Invalid API
version"*); package creation exists on both, with different shapes.

**`ship_type` is order↔package cardinality, not a shipping method.**

| Value | Meaning | Our use |
|---|---|---|
| `1` | One order → one package | a combine group holding one order |
| `2` | One order → several packages | **never** — breaks one-label-one-box |
| `3` | Several orders → one package | a combine group holding several orders |

This maps exactly onto `synced_order_ids.auto_combine_group_id`, which Lensed already computes and
the pick path already treats as the box. `order_list_ids` is the input to `ship_type: 3` — it is
**not** a way to create many packages in one call. Calls scale with boxes.

**`document_type` values**, from the API's own tooltip:

`SHIPPING_LABEL` (PDF, what we want) · `PACKING_SLIP` · `SHIPPING_LABEL_AND_PACKING_SLIP` ·
`SHIPPING_LABEL_PICTURE` (PNG) · `HAZMAT_LABEL` (PDF, **size forced to A4**) · `INVOICE_LABEL`
(Brazil only).

**`document_size` defaults to A6** (105 × 148 mm), which is close enough to the 4×6 label stock in
use (101.6 × 152.4 mm) that the default is correct. A5 is the only alternative.

**Package creation on 202512 is the label generator.** A probe with an invalid `ship_type` and no
order returned `21042204: "Couldn't generate the shipping label because no matching package was
found."` — it failed *only* because no order was named. Treat that endpoint as the money endpoint.

**A batch document fetch exists** — `POST /api/fulfillment/batch_get_documents`, taking
`package_list[]` of `{package_id, document_type, document_size}`. It is Legacy, on 202212, and its
enums are numbers rather than strings (`A6 = 0`, `A5 = 1`). Build against the New single call; keep
this in reserve for when call volume hurts.

---

## 3. Choosing what to buy — entirely from Lensed's own data

No API call is needed to decide *which* orders to buy for. The linkage already exists:

```
live_sessions.id
  ← live_auction_items.session_id
      ← live_auction_items.client_idempotency_key = synced_order_ids.order_id
          → synced_order_ids.auto_combine_group_id   (the box, one label)
              → live_auction_item_skus               (the SKUs in it)
```

So "buy labels for these shows" is a query, and each box arrives already knowing its SKUs — which is
what the grouping needs.

### Excluding a running show

**Never gate on `live_sessions.status = 'live'`.** CLAUDE.md forbids it as an interlock and it is
unreliable. Use the heartbeat, `live_sessions.last_seen_at`.

Measured 2026-09-03 04:48 UTC: 7 sessions heartbeating within 20 minutes, 7 flagged `status='live'`,
**zero disagreement in either direction**, and **2,105 orders** attached to those sessions. That is
the volume that would be wrongly purchased if this exclusion were missing or wrong.

The job must **refuse to run rather than guess** if a session's heartbeat is ambiguous — a stale
heartbeat on a show that is actually running is the expensive case.

### Eligibility, per box

A box is eligible only if all hold:

- every order in it is `AWAITING_SHIPMENT` (or whatever TikTok's pre-label state is — see Open)
- no order in it belongs to a session heartbeating inside the window
- no label has already been bought for it (§5)
- it is not hazmat, or hazmat routing is resolved (§4)

---

## 4. Hazmat — UNRESOLVED, and it blocks a full rollout

`HAZMAT_LABEL` forces `document_size` to **A4**. Labels are printed one per **4×6**. An A4 label
cannot come off that printer, so hazmat packages need a different document type *and* different
paper, and cannot be in the same print run.

**Lensed cannot currently tell which packages are hazmat.** Verified 2026-09-03: there is no hazmat
or dangerous-goods column anywhere in the schema — not on `inventory_skus`, not on
`synced_order_ids`, nowhere.

**This is not a corner case.** Lithium cells are hazmat for shipping, and the catalogue is full of
them — `#5 RC drift car`, `#7 RC helicopter`, `#8 RGB speaker`, `#16 jbl speaker`,
`#30 Mini Powerbank`, `#6 1080p Action camera`. Hazmat also has prior form here: the "scan fail"
incident that turned out to be a tracking-sync gap.

Three ways out, none free:

1. **A manual flag on `inventory_skus`** (`is_hazmat boolean`). The operator knows the catalogue
   better than any inference. Cheap, one migration, but it is only as good as the data entry — and a
   *missed* flag means requesting `SHIPPING_LABEL` for a hazmat package.
2. **Ask TikTok.** The order or package payload may carry a hazmat indicator. Unknown — needs
   checking against the order detail response before relying on it. Preferable if it exists, because
   it cannot drift out of date.
3. **Attempt and recover.** Request `SHIPPING_LABEL`; if TikTok refuses for a hazmat package, catch
   it and re-request `HAZMAT_LABEL`. Self-correcting and needs no new data — *provided* TikTok
   actually errors rather than silently returning something wrong-sized. Unverified.

**Recommendation:** check (2) first. If TikTok tells us, use it. Otherwise (1) as the source of
truth with (3) as a safety net, and **exclude hazmat boxes from the first real run entirely** so the
unknown is never load-bearing on a purchase.

---

## 5. Purchase safety

At ~1,300 boxes a day and three calls each, this cannot be a request — it is a resumable background
job. Which raises the failure mode that matters: **if it dies at box 800, 800 labels are already
bought.** A naive retry buys them again.

**A purchase ledger is therefore a prerequisite, not a refinement.** One row per box, written *as
each purchase succeeds*, unique on the box key, so a retry skips what is already done. Roughly:

```
label_purchases
  user_id, store_id
  group_key            -- the box; UNIQUE with user_id
  order_ids[]          -- what went into it
  ship_type            -- 1 or 3
  tiktok_package_id
  tracking_number
  document_url_or_ref
  purchased_at
  batch_id             -- which run bought it
```

Every write happens **before** the run moves on, never batched at the end. The unique constraint on
`(user_id, group_key)` is the actual guard against double-buying — the same pattern
`shipment_verifications` already uses for confirms.

Also required:

- **Off by default**, behind a flag, log-only on first deploy
- **A hard cap** on boxes per run, so a bug is bounded in cost
- **Throttling and backoff**, as the tracking-sync cron already does
- **Refuse to start** if any candidate box belongs to a heartbeating session

---

## 6. Assembly

Once every eligible box has a label, build one PDF.

**Order:** single-SKU/single-unit boxes first, grouped by SKU; everything else after.

**Before each SKU group, a generated 4×6 separator page** carrying the SKU number and title copied
from `inventory_skus` — `#248 PUMPKIN GLITTER` — and the count in that batch.

```
[ slip: #248 PUMPKIN GLITTER · 20 ]
   20 labels
[ slip: #198 DUMPLING SEALED · 20 ]
   20 labels
[ slip: #401 CHEESE LARGE · 10 ]
   10 labels
[ slip: BUNDLES · 50 ]
   50 labels, ungrouped
```

**Only single-SKU *single-unit* boxes are batched.** A multi-unit same-SKU order breaks the packer's
mechanical loop: they would have to notice that one label needs three items rather than one, which
means reading every label and losing the speed the batch exists for. Those 439 boxes go with the
bundles, where reading and counting is already the job.

*(Possible later refinement: group by SKU **and** quantity, so a `#248 × 3 each` batch keeps its own
mechanical loop. Recovers 1.6% of volume at the cost of a second rule on the floor. Not in v1.)*

Assembly needs no PDF text extraction — we know which document belongs to which order because we
requested it. Slip pages are generated; label pages are copied in. `pdf-lib` is sufficient.

---

## 7. Dry run — read before anything is bought

The job's first mode prints what it *would* do and buys nothing:

- boxes eligible, by shop
- how many are single-SKU/single-unit vs bundles
- the SKU groups and their counts, in the order they would print
- boxes excluded, **with the reason** — heartbeating session, already purchased, hazmat, wrong status
- the total cost, if the API returns one (see Open)

This output is the approval gate. Nothing is purchased until it has been read.

---

## 8. Open questions

Must be answered before code, not assumed:

1. **Is the label response a URL or base64 bytes?** Decides whether assembly downloads or decodes.
2. **`handover_method` accepted values** — string, but the enum is unknown.
3. **Does the response carry a cost?** Without it the dry run cannot total the spend, which weakens
   the approval gate considerably.
4. **Which order status is label-ready**, and does buying a label transition it automatically?
5. **Does TikTok expose a hazmat indicator?** (§4)
6. **Rate limits** on the fulfillment endpoints.

---

## 9. Sequencing

1. Re-authorise the remaining shops — `lotsofsteals`, `Lux viral`, `Toysfordeals` still hold
   pre-scope tokens. Nothing can run for them until then. Re-auth is in-place via
   `/api/tiktok/auth?store_id=…`; **`Disconnect` deletes that store's synced orders** and must not
   be used for this.
2. Close the Open questions above.
3. Migration: the purchase ledger, plus `is_hazmat` if that route is chosen.
4. The selection query and the dry run — **no purchasing code at all**. Review its output against
   Seller Center for a day already bought by hand.
5. Purchasing behind a flag, log-only, then one real run with a hard cap on a single small show.
6. Assembly and the slip pages.
7. Only then, a full day across all shops.

Steps 4 and 5 are the ones not to compress. Everything before them is reversible; a purchase is not.
