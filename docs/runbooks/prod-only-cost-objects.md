# Prod-only cost objects — drift snapshot (captured 2026-09-11)

**Status: DOCUMENTATION ONLY. This branch deliberately changes none of these objects.**

Production contains live database objects that affect FIFO COGS and that appear **nowhere** in
`supabase/migrations/`. CLAUDE.md states the repo migration file is the only record this database
has. For these objects that record was missing, so anyone reading the repo would draw the wrong
conclusion about how uncosted sales behave. This file closes that gap by *recording* the objects,
not by touching them.

Verbatim captures live in [`prod-only-cost-objects/`](./prod-only-cost-objects/). They are
snapshots, **not migrations** — do not apply them.

---

## 1. `lensed_recompute_sku_cost_scalar()` — the per-minute cost mirror

| | |
|---|---|
| Signature | `public.lensed_recompute_sku_cost_scalar()` → `integer` |
| Language | `plpgsql` |
| Security | **SECURITY DEFINER** |
| Config | `search_path = public`, `lock_timeout = 2s` |
| Owner | `postgres` |
| Grants | `postgres=X`, `service_role=X` — **not** granted to `anon`/`authenticated` |
| Schedule | `pg_cron` job `sku_cost_scalar_recompute_1m`, `* * * * *` (every minute), active |
| First observed run | **2026-08-29 00:59:00 UTC** |
| Runs logged | 20,161 as of capture |
| Rows changed, lifetime | 62 |
| Repo record | **none** — `git grep lensed_recompute_sku_cost_scalar origin/main` returns nothing |

Its own `COMMENT ON FUNCTION` (present in production):

> Recomputes inventory_skus.unit_cost_cents from the oldest sku_batches layer with qty_remaining
> > 0 (sequence asc), catalog-wide, in one statement. Preserve semantics: never writes NULL.
> Returns rows changed; logs every run to sku_cost_mirror_runs. Scheduled via pg_cron; not called
> from the app.

### What it actually does

```sql
with target as (
  select distinct on (b.sku_id) b.sku_id, b.unit_cost_cents
    from public.sku_batches b
   where b.qty_remaining > 0
   order by b.sku_id, b.sequence asc          -- the FRONT FIFO layer
)
update public.inventory_skus s
   set unit_cost_cents = t.unit_cost_cents
  from target t
 where t.sku_id = s.id
   and t.unit_cost_cents is not null          -- PRESERVE: never writes NULL
   and s.unit_cost_cents is distinct from t.unit_cost_cents;   -- idempotent
```

It also inserts one row per run into `sku_cost_mirror_runs` and prunes that log to 14 days.

### Why it matters to FIFO COGS

Every P&L surface in Lensed derives cost from one expression:

```sql
qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents, 0)
```

(`las` = `live_auction_item_skus`; ~20 definitions across migrations 039, 040, 089, 103, 106, 109,
111, 113, plus the `pnl_order_grain` view.)

The **first** operand is frozen at bind time. The **second** — the fallback used whenever a sale
line has a `NULL` snapshot — is exactly the column this cron rewrites every 60 seconds.

Consequences, all verified against production:

1. A batch created with a **`NULL`** cost snapshots `NULL` onto its sale lines. Those lines are
   therefore priced at *whatever the SKU's current front layer costs right now* — a number that
   moves on its own. Entering the real cost later **does** retroactively change closed periods,
   within a minute, with no audit trail. That is not FIFO-correct: it applies the current front
   layer's cost to every `NULL`-snapshot line for the SKU regardless of which layer each actually
   drew from, and it stops working the moment that layer reaches `qty_remaining = 0`.
2. A batch created with **`0`** snapshots `0`, which wins the `coalesce` and is frozen forever.
   Worse, `0` is `not null`, so it passes the mirror's PRESERVE filter and gets written onto
   `inventory_skus.unit_cost_cents` while that layer is at the front — contaminating the fallback
   for other sales of the same SKU, and the "Inventory value (active)" card, which is computed as
   `unit_cost_cents × qty_on_hand` (`src/components/inventory/InventorySection.tsx:252`).

### Observed state at capture (2026-09-11)

| Measure | Value |
|---|---|
| SKUs with a front layer (`qty_remaining > 0`) | 167 |
| …whose `inventory_skus.unit_cost_cents` equals that layer's cost | **167 / 167** (fully converged) |
| SKUs with **no** positive layer — mirror cannot reach them, scalar frozen | 262 |
| `sku_batches` rows total | 790 |
| …with `unit_cost_cents IS NULL` | 8 |
| …with `unit_cost_cents = 0` | 1 |
| `live_auction_item_skus` rows total | 178,632 |
| …with `unit_cost_cents_snapshot IS NULL` | 487 |
| …with `unit_cost_cents_snapshot = 0` | 0 |
| Sold units in the trailing 30 days with **no cost at all** (`coalesce(snapshot, scalar) IS NULL`) | **30**, across 2 SKUs |

### This branch does NOT modify it

Deliberately. It is working, converged, and 487 existing sale lines currently depend on its output
for their reported cost. Replacing or dropping it is a **separate, reviewed decision** — the right
time is alongside the historical-repricing RPC, when `source_batch_id` makes per-line cost
attributable and the fallback stops mattering. Re-declaring it via `CREATE OR REPLACE` now, purely
so migration history looks complete, would take a lock on a live-path function and buy nothing.

---

## 2. `sku_cost_mirror_runs` — the mirror's run log

See [`prod-only-cost-objects/sku_cost_mirror_runs.prod.sql`](./prod-only-cost-objects/sku_cost_mirror_runs.prod.sql).
`bigserial` PK, one row per cron tick, `ran_at DESC` index, RLS enabled with **no policies**
(readable only by the owner / `service_role`). Self-pruning to 14 days by the function itself.

---

## 3. `lensed_add_batch_admin` — ~~repo/prod drift~~ **CORRECTED: no drift**

*An earlier revision of this file claimed production had drifted from the repo here. That was
wrong, and it is corrected rather than deleted because a rollback plan was briefly written
against it.*

Migration **045** does not stamp `qty_added`. Migration **046** redefines the same function and
**does**, and 046 is byte-identical to the live body (verified by normalized diff against
`prosrc`). 045 is simply superseded — the ordinary redefinition pattern this repo uses
everywhere. Migration 083's header assertion that "the ViewTrack path already does (045/046)"
is correct as written.

**Consequence for rollback:** the pre-feature body of `lensed_add_batch_admin` is recoverable
from `046_viewtrack_void_batch.sql`, not from 045. Reverting from 045 would drop `qty_added`
stamping on every new ViewTrack layer.

The live capture is retained at
[`prod-only-cost-objects/lensed_add_batch_admin.prod.sql`](./prod-only-cost-objects/lensed_add_batch_admin.prod.sql)
as a belt-and-braces reference.

## 4. `pnl_order_grain` — the canonical COGS view, defined nowhere in the repo

`rg "create (or replace )?(materialized )?view"` across the entire repository returns **zero
hits**, yet `public.pnl_order_grain` is live and is the order-grain surface behind
`pnl_by_show_as`, `chat_pnl_totals_as` and the owner dashboard (`/api/tiktok/product-stats`
selects from it directly). Captured verbatim at
[`prod-only-cost-objects/pnl_order_grain.prod.sql`](./prod-only-cost-objects/pnl_order_grain.prod.sql).

Its cost expression — `sum(las.qty * coalesce(las.unit_cost_cents_snapshot, isk.unit_cost_cents))`
— reads the snapshot dynamically, which is why migration 154's reprice propagates to it with
no further work. `supabase/tests/fifo_source_batch/pnl_surfaces.sql` installs this exact text
in the throwaway test database so the propagation is **proven, not assumed**.

## 5. Other prod-only objects (named here, not addressed)

`git grep` across `origin/main` finds no mention of these live `public` functions:

`pnl_materialize_daily`, `snapshot_ac_boxes`, `can_access_store`, `cubicle_state`,
`current_store`, `enforce_page_limit`, `is_store_owner_in_org`, `set_store_id_from_bizconn`,
`touch_device`

plus the tables `pnl_daily_fact` and `pnl_refund_events`.

---

## Known issues recorded here, explicitly NOT fixed in this branch

| Issue | Evidence |
|---|---|
| `pnl_daily_fact` is a materialized P&L table that is **stale and unscheduled** — `max(computed_at)` = 2026-08-16, 112 rows. `pnl_materialize_daily` is in no cron job. | `select max(computed_at) from pnl_daily_fact`; `cron.job` has 2 jobs, neither is this |
| `entries` is **frozen at 2026-07-31** (`max(updated_at)` = 2026-08-01 09:24 UTC) — the `rebuild_entries` outage. The iOS app's entire P&L reads this table. | `select source, max(date), max(updated_at) from entries group by 1` |
| `lensed_delete_auction_item` restocks `inventory_skus.qty_on_hand` for a deleted **sold** item but never restores the drawn `sku_batches` layer, drifting the 034 lockstep invariant. Flagged as out-of-scope by migration 083; still unfixed. | prod `prosrc` contains no reference to `sku_batches` |
| `lensed_add_batch`, `lensed_edit_batch`, `lensed_delete_batch`, `lensed_settle_batch`, `lensed_log_auction` and `lensed_unbind` all carry `=X/postgres` (PUBLIC) **and** `anon=X` in `proacl`, despite `202608161754_revoke_anon_write_rpcs.sql`. | `select proacl from pg_proc …` |
| 30 sold units in the trailing 30 days carry no cost on any surface (both snapshot and SKU scalar `NULL`) — chiefly SKU 435 "Clear Vaseline Magic Figure", which is also at `qty_remaining = -4`. | see table above |

---

## How this was captured (read-only, reproducible)

Supabase Management API query endpoint against project `dvucodtdojumvplmgjeu`, using only
`pg_catalog` / `information_schema` reads and `SELECT` aggregates. No RPC was invoked, no row was
written. The exact reads: `pg_proc` (`prosrc`, `proacl`, `prosecdef`, `proconfig`, `proowner`,
`pg_get_functiondef`), `pg_constraint`, `pg_indexes`, `pg_policies`, `pg_trigger`, `cron.job`,
`information_schema.columns`, and counts over `sku_batches`, `inventory_skus`,
`live_auction_item_skus`, `entries`, `pnl_daily_fact`, `sku_cost_mirror_runs`.
