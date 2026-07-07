# ViewTrack → Lensed inventory integration — design

**Status:** design only — nothing in this document is built yet. Review before implementation.
**Branch:** `feat/viewtrack-integration`
**Author/date:** design drafted 2026-07-07.

## Purpose

ViewTrack (a separate Next.js + Supabase inbound-inventory / ops tracker) knows when a
shipment physically lands and what it actually cost (unit + freight + duties). Lensed
represents cost as **FIFO batches** (`sku_batches`) under a SKU. This integration lets
landed inventory in ViewTrack flow into Lensed as a **new batch under an existing SKU**,
carrying the true landed unit cost — without rewriting any recorded P&L and without
auto-listing anything.

```
ViewTrack UI ──► ViewTrack backend ──HTTPS + shared secret──► Lensed /api/integrations/viewtrack/*
 (browser)        (holds the secret)                            (service-role, org-scoped)
                                                                        │
                                                        lensed_add_batch_admin (SECURITY DEFINER)
                                                                        │
                                                    inventory_skus / sku_batches (one shared org pool)
```

The shared secret lives **only** on ViewTrack's backend. ViewTrack's browser talks to
ViewTrack's own backend, which proxies to Lensed — a single server-to-server trust boundary.

## Decisions locked for this design

1. **Org binding:** single env var `LENSED_VIEWTRACK_ORG_ID` for now (no `integration_credentials` table yet).
2. **Batch attribution:** a **dedicated integration/system user** (`LENSED_VIEWTRACK_SYSTEM_USER_ID`); fall back to `organizations.owner_user_id` if provisioning the system user is impractical. Either way, every batch is stamped `source='viewtrack'`.
3. **Write path:** a new `lensed_add_batch_admin` **SECURITY DEFINER** RPC that keeps the advisory-lock + qty-lockstep invariants in one place. The existing `lensed_add_batch` is `security invoker` and raises `NOT_AUTHENTICATED` under the service role, so it cannot be reused.
4. **Currency:** assume USD **cents**; validated on the ViewTrack side before send.
5. **Endpoint addressing:** `sku_id` in the path (`/skus/[id]/batches`), matching the existing `/api/inventory/skus/[id]/batches` convention.

## Current-state facts this design relies on

- Lensed Supabase project `dvucodtdojumvplmgjeu`. Existing app routes authenticate via the
  Supabase **auth cookie** (`src/lib/supabase/server.ts`), so an external app cannot call
  them with an API key — hence the new service-role namespace below.
- Service-role admin client already exists: `createAdminClient()` in `src/lib/supabase/admin.ts`
  (bypasses RLS; `auth.uid()` is NULL).
- Inventory is **org-shared** (`035b_shared_inventory_orgs.sql`): one physical pool per org across
  `inventory_skus`, `sku_batches`, `products`, `product_costs`. Today the real dataset sits under
  a single org (owner `f5885f7d-5841-457c-b66f-a5aa2916db46`).
- `sku_batches` (`034_fifo_batch_pricing.sql`): FIFO cost layers with `qty_remaining`, per-batch
  `unit_cost_cents`, `sequence`. `user_id` is **NOT NULL** → any insert needs a real `auth.users` row.
- Invariant: `inventory_skus.qty_on_hand` stays in lockstep with `Σ sku_batches.qty_remaining`.
  Adding a batch bumps `qty_on_hand`; it does **not** touch `is_active`.
- Sellability is governed by `is_active`; the live picker filters on it
  (`HostTrackingShell.tsx:79`, `InventorySection.tsx:185`). Adding a batch therefore never
  surprise-lists a paused SKU.
- Option A (never rewrite history): a new batch only affects the cost of **future** sales; recorded
  `unit_cost_cents_snapshot` rows are untouched.
- `src/lib/env.ts` validates required env vars **at import time** (throws if missing). The new
  integration vars must therefore be read **lazily** inside the integration routes — do NOT add
  them to the eager `requireEnv` block, or an unset var would crash the entire app.

---

## 1. Lensed: two new service-role endpoints + shared-secret auth

New namespace: `src/app/api/integrations/viewtrack/*`. These routes use `createAdminClient()`
(service role), **not** `createClient()`. Because RLS is bypassed, **org scoping is the
endpoint's own responsibility** (see §2).

### 1.1 Shared-secret auth

- One high-entropy token (≥32 random bytes, e.g. `vt_live_…`), stored as `LENSED_VIEWTRACK_SECRET`
  on Lensed and the identical value in ViewTrack's backend env.
- Transport: `Authorization: Bearer <token>`.
- Verification helper (sketch), read lazily so a missing var 500s only the integration route:

```ts
// src/lib/integrations/viewtrack-auth.ts  (proposed)
import { timingSafeEqual } from 'node:crypto';

export function assertViewTrackAuth(req: Request): { orgId: string } {
  const secret = process.env.LENSED_VIEWTRACK_SECRET;
  const orgId = process.env.LENSED_VIEWTRACK_ORG_ID;
  if (!secret || !orgId) throw new IntegrationError(500, 'Integration not configured');

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new IntegrationError(401, 'Unauthorized');

  return { orgId };
}
```

- The secret is **bound to one org** via `LENSED_VIEWTRACK_ORG_ID`. This is what makes org
  resolution deterministic with no Lensed user session. Upgrade path (not now): an
  `integration_credentials(token_hash, org_id, scopes)` table swaps in behind this helper without
  changing endpoint shapes.
- **Middleware check:** confirm `src/middleware.ts`'s matcher does not run session-refresh/redirect
  on `/api/integrations/*` (these requests carry no Supabase cookie and must not be bounced). Add an
  exclusion if the matcher is broad.

### 1.2 Endpoint A — read catalog

`GET /api/integrations/viewtrack/skus`

- `assertViewTrackAuth(req)` → `orgId`.
- Admin client → `inventory_skus` filtered `.eq('org_id', orgId)`, ordered by `sku_number`, with a
  batch-count rollup (mirrors the shape of the existing `GET /api/inventory/skus`).
- Response per SKU:

```json
{
  "skus": [
    {
      "id": "uuid",
      "sku_number": 42,
      "title": "Widget",
      "thumbnail_url": "https://…/inventory-thumbnails/…",  // derived from thumbnail_path (public bucket, no signing)
      "is_active": true,
      "qty_on_hand": 17,
      "batch_count": 3
    }
  ]
}
```

- Return inactive SKUs too, flagged, so ViewTrack can grey them rather than hide a valid mapping target.
- Read-only; ViewTrack may cache briefly.

### 1.3 Endpoint B — add batch

`POST /api/integrations/viewtrack/skus/[id]/batches`

- `id` (path) = Lensed `sku_id`.
- Body: `{ "qty": 12, "unit_cost_cents": 850, "external_ref": "vt_shipment_line_9931", "idempotency_key": "optional" }`.
- Validation: `qty` integer ≥ 0; `unit_cost_cents` integer ≥ 0 with a sane upper cap; `external_ref`
  non-empty string.
- Calls the new definer RPC (§2), passing the resolved `orgId`. Does **not** call `lensed_add_batch`.
- Response:

```json
{ "ok": true, "batch_id": "uuid", "sku_id": "uuid", "qty_on_hand": 29, "replayed": false }
```

- `replayed: true` when the same `external_ref` was already applied (idempotent no-op) — ViewTrack
  should treat this as success ("already sent"), not an error.

---

## 2. Org resolution on the write path + the new RPC

Resolution chain, end to end:

**shared secret → `LENSED_VIEWTRACK_ORG_ID` → passed to the RPC as `p_org_id` → RPC re-verifies the SKU belongs to that org.**

The org is never guessed from a user or a "first membership." `getOrgId()` in `src/lib/org.ts`
remains the fallback pattern if we ever key off a Lensed user instead, but secret→org is the chosen path.

### 2.1 Batch attribution user

`sku_batches.user_id` is NOT NULL and FKs `auth.users`. Preferred: a **dedicated integration user**,
provisioned once via the service-role admin auth API and pinned in env:

```ts
// one-time provisioning (run once, then store the returned id in LENSED_VIEWTRACK_SYSTEM_USER_ID)
const admin = createAdminClient();
const { data } = await admin.auth.admin.createUser({
  email: 'viewtrack-integration@lensed.internal',
  email_confirm: true,
  user_metadata: { role: 'integration', source: 'viewtrack' },
});
// data.user.id → LENSED_VIEWTRACK_SYSTEM_USER_ID
```

Fallback if provisioning proves impractical: use `organizations.owner_user_id` for the target org
(resolvable inside the RPC). **Either way, every batch is stamped `source='viewtrack'`**, so
attribution/audit does not depend on which user id is used.

**Attribution is passed as an explicit RPC parameter, not a GUC.** The original sketch set
`app.viewtrack_system_user` via `set_config` and read it inside the RPC — but that is NOT viable
over supabase-js/PostgREST: each `.rpc()` runs in its own pooled transaction, so a separate
`set_config` call lands on a different connection and is lost (attribution would silently fall back
to org-owner). Passing `p_system_user_id` as a parameter guarantees same-transaction attribution.
The endpoint requires `LENSED_VIEWTRACK_SYSTEM_USER_ID` (500s if unset) so the fallback never fires.
**Verified on the isolated test: both created batches carried `user_id` = the integration user.**

### 2.2 Schema addition (proposed migration)

A new migration (`04X_viewtrack_batch_provenance.sql`) adds provenance + the idempotency guard:

```sql
alter table public.sku_batches
  add column if not exists source text,          -- e.g. 'viewtrack'
  add column if not exists external_ref text;    -- ViewTrack shipment-line id

-- idempotency: a given external ref lands at most once per org
create unique index if not exists uq_sku_batches_source_ref
  on public.sku_batches (org_id, source, external_ref)
  where source is not null;
```

### 2.3 The new RPC (proposed, SECURITY DEFINER)

Keeps the advisory-lock + qty-lockstep invariants co-located with the existing FIFO logic.

**As built** — see [`supabase/migrations/045_viewtrack_add_batch_admin.sql`](../supabase/migrations/045_viewtrack_add_batch_admin.sql)
for the authoritative version. Key points of the final implementation:
- Signature: `lensed_add_batch_admin(p_org_id, p_sku_id, p_qty, p_unit_cost_cents, p_external_ref, p_system_user_id)`
  — attribution user is an explicit parameter (see §2.1).
- Bounds: `p_qty > 0` (no zero-qty layers); `p_unit_cost_cents` required and `0..100000`
  (`INVALID_COST` otherwise) — the $1,000/unit hard cap, no unbounded check.
- SKU/org verification (`SKU_NOT_FOUND`), attribution `coalesce(p_system_user_id, org owner)` with a
  `NO_ATTRIBUTION_USER` guard, per-SKU advisory lock (`'sku:'||p_sku_id`, same key as
  `lensed_log_auction`), idempotency pre-check on `(org_id, 'viewtrack', external_ref)`.
- The `UPDATE inventory_skus` aliases the target table (`s`) so its `qty_on_hand` column is
  unambiguous against the RETURNS-TABLE out-column of the same name (this bit us once — 42702).
- `security definer`, `revoke`d from `public`/`authenticated`: reachable only via the service role.

Notes:
- The idempotency guard (unique index `uq_sku_batches_source_ref`) is the real safety net; the in-RPC
  pre-check just makes replays return cleanly instead of erroring on the constraint.

---

## 3. ViewTrack-side changes

### 3.1 Data model

- Product/item: add optional `lensed_sku_id uuid` (+ cached `lensed_sku_number`, `lensed_title`
  for display). Null = not linked.
- Landed shipment line: add `lensed_batch_id`, `sent_to_lensed_at`, `send_status`
  (`unsent | sent | error`) so a line is sent at most once and status is visible.

### 3.2 SKU picker

- A ViewTrack backend route (e.g. `/api/lensed/catalog`) proxies to **Endpoint A** using the
  secret (server-side only). The browser calls ViewTrack's route, never Lensed directly.
- UI: searchable list showing thumbnail + `sku_number` + title; inactive SKUs greyed. The user maps
  a ViewTrack item → Lensed SKU once; the mapping persists on the item.

### 3.3 "Send to Lensed" action

- On a landed shipment line for a mapped item:
  - Compute **landed unit cost** (unit + allocated freight/duties) → integer **cents** (USD).
  - Validate currency is USD and value is a non-negative integer of cents **before** send.
  - POST via ViewTrack's backend → **Endpoint B**:
    `{ sku_id: item.lensed_sku_id, qty, unit_cost_cents, external_ref: <shipment-line id> }`.
    The shipment-line id as `external_ref` is what makes retries safe.
- On success: store `lensed_batch_id`, set `send_status='sent'`, show the returned `qty_on_hand` as
  confirmation. Treat `replayed:true` as "already sent."
- Guardrails: block send if the item isn't mapped; block if currency isn't USD; require `qty > 0`.
- Confirmation step: echo the resolved Lensed SKU title back in the UI before sending, to catch a
  wrong mapping.

---

## 4. Security considerations

- **Blast radius (bounded):** a batch write changes `qty_on_hand` and adds a cost layer that
  **future** sales draw from — it affects stock and forward P&L / oversell gating. It is **not
  retroactive** (Option A) and does **not** auto-list (`is_active` untouched). Worst case is wrong
  stock/cost on future sales, not a surprise listing.
- **Least privilege:** the secret grants exactly two operations (read catalog, add batch) on **one
  org**. The definer RPC can only append a batch — it cannot delete, toggle active, or read
  orders/payouts/P&L. This is strictly narrower than handing over the service-role key.
- **Idempotency = correctness:** the `(org_id, source, external_ref)` unique index is mandatory.
  Without it a retried POST double-lands stock.
- **Secret hygiene:** server-side only, never in the browser bundle; distinct per environment;
  rotatable. Constant-time compare; reject missing/oversized headers. Read lazily (never in the
  eager `requireEnv` block in `src/lib/env.ts`).
- **Input validation:** integer `qty ≥ 0`; `unit_cost_cents ≥ 0` with a sane upper cap; SKU
  re-verified against the org inside the RPC.
- **Wrong-SKU / wrong-org is the top risk.** Mitigations: explicit secret→org binding, in-RPC
  org/SKU verification, and the ViewTrack confirm step echoing the SKU title.
- **Audit:** every batch stamped `source='viewtrack'` + `external_ref`, traceable and reconcilable.
- **Transport & abuse:** HTTPS only; basic rate-limiting on the two routes; optionally IP-allowlist
  ViewTrack's egress.

---

## 5. Known gaps / future work

- **No reversal path yet.** A mistakenly sent batch cannot be cleanly undone today: `lensed_settle_batch`
  only zeroes a *negative* layer, and there is no void/adjust operation. If a wrong batch (wrong qty,
  cost, or SKU) is pushed, correction is currently **manual** (direct DB edit) — and because
  `qty_on_hand` moves in lockstep and FIFO draws are order-sensitive, a naive manual delete can break
  the invariant. **Future feature:** a `lensed_void_batch` / `lensed_adjust_batch` RPC that reverses a
  batch's `qty_remaining` contribution and its `qty_on_hand` bump atomically (guarded so it can't be
  used to erase already-drawn cost history), exposed to ViewTrack as an "undo send" that references the
  original `external_ref` / `lensed_batch_id`.
- **Single org only** (env-bound). Multi-org support later via an `integration_credentials` table.
- **USD-only.** Multi-currency (carry currency + convert) is out of scope for this iteration.

---

## 6. Implementation checklist

Lensed side — **built + tested in isolation 2026-07-07** (throwaway SKU 990001, deleted after):

- [x] Migration `045_viewtrack_add_batch_admin.sql`: `source`, `external_ref`, unique index, RPC. Applied to prod DB.
- [x] `lensed_add_batch_admin` SECURITY DEFINER RPC (qty>0, cost 0..100000, idempotent, org+SKU verified).
- [x] Provisioned dedicated integration user; id in `LENSED_VIEWTRACK_SYSTEM_USER_ID`.
- [x] `src/lib/integrations/viewtrack-auth.ts`: `assertViewTrackAuth` (lazy env, constant-time compare, no silent fallback).
- [x] `GET /api/integrations/viewtrack/skus` (Endpoint A) — catalog fields only.
- [x] `POST /api/integrations/viewtrack/skus/[id]/batches` (Endpoint B).
- [x] `src/middleware.ts` matcher excludes `/api/integrations/*` (verified: cookieless call returns 401 JSON, not a `/login` redirect).
- [x] Env set in `.env.local`: `LENSED_VIEWTRACK_SECRET`, `LENSED_VIEWTRACK_ORG_ID`, `LENSED_VIEWTRACK_SYSTEM_USER_ID`.

Isolated test results (all pass): auth reject (no/wrong secret → 401); catalog exposes only
`{id, sku_number, title, thumbnail_url, qty_on_hand, is_active, batch_count}`; qty≤0 → 400;
cost>100000 → 400; missing external_ref → 400; unknown sku_id → 404; valid add → `replayed:false`;
same external_ref → `replayed:true` + same `batch_id` + qty unchanged (one batch); attribution
`user_id` = integration user on every batch; lockstep `qty_on_hand == Σ qty_remaining`.

ViewTrack side — **not started** (next phase, pending review of the Lensed side):

- [ ] `lensed_sku_id` mapping field on products/items.
- [ ] Catalog proxy route + SKU picker (thumbnail + sku_number + title, inactive greyed).
- [ ] "Send to Lensed" action — confirm step echoes **qty + unit cost + SKU title** (irreversible), posts batch, tracks send-state.

### Deployment note (before this ships to prod traffic)
The three `LENSED_VIEWTRACK_*` env vars currently live only in local `.env.local`. They must be added
to the hosting env (Vercel) for the endpoints to work in production. The shared secret must be
generated/stored there too — treat it as a production credential.
</content>
</invoke>
