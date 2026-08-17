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

## Confirming the feature actually works end to end

You need a genuinely short bind. The next time a host sells at zero and the team
binds with "Bind anyway" (`allow_negative`), that order line gets
`short_at_bind = true`. When its label is later scanned, the pick card shows the
dimmed image and the red **OUT OF STOCK** band — on that order's box only, not
on every box holding the same SKU.

```sql
-- what has been flagged so far
select ai.client_idempotency_key as order_id, s.sku_number_snapshot, s.qty, s.short_at_bind
from live_auction_item_skus s
join live_auction_items ai on ai.id = s.auction_item_id
where s.short_at_bind is true
order by s.created_at desc limit 20;
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
