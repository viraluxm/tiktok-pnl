# Lensed — Consolidated Identity / Auth Phase (Design Spec, rev. 3 — FINAL)

**Status:** design only — nothing built, no migrations. Authoritative; we build chunks 1→11 (+ optional 12) afterward. **RLS cutover is DEFERRED out of this phase** (see §6).
**Rev 3** resolves all open questions (Q2–Q9) and records the login model.
**Context:** follows prod migrations 036 (stores/pages/store_id), 037 (fulfillment org-RLS), 038 (unbound flag) and the completed per-person→per-store data re-key.

---

## 0. Login model (context that anchors the whole design)

- **One login per shop.** A shop-login owns up to **5 live accounts** (= the existing `store` → ≤5 `pages`). It is **not** user-switches-shops, and **not** multiple logins per shop.
- Per-store logins are therefore **1:1 with stores today** → `user_id`-RLS ≈ `store_id`-RLS in practice. This is why the **RLS cutover stays deferred** (§6).
- A future **multi-shop owner account** is possible but deferred — it would balloon connections at 5 pages/shop, and it's the trigger that would later justify the cutover.

---

## 1. Goals & principles

- **Two contexts, device-provisioned.** A machine is a **store context** (owner workstation) or a **fulfillment context** (warehouse device). Provisioning decides; it persists.
- **Per-store logins stay as-is.** Each store keeps its current login (Snore→Snore, lots-of-steals→lots-of-steals) for all store work. The **only** new auth piece is the **fulfillment device login**. No org-owner mega-login. A cross-store view-all switcher is **optional** (chunk 12), not core.
- **Device session ≠ worker identity.** A device authenticates **once** (shared org fulfillment account); **many workers** select their name per shift. Selected worker is app-level identity layered on top.
- **Shift lifecycle with breaks.** Name-select → `working`; **Break** → `on_break` (time **excluded** from KPIs); **End shift** → name-select; **idle auto-end at 10 min** (working-state only); a **never-resumed break auto-caps at 60 min** and ends the shift. Break ≠ idle.
- **KPIs from day one (capture + basic display).** Stamp `picked_by`/`packed_by`; shifts capture working/break intervals. A **basic org-wide worker-KPI dashboard** (one shared worker pool across both stores) reports **active-time throughput (total − breaks)**, visible **only to lots-of-steals + Snore** via an explicit allowlist.
- **Role-gated by device-kind eligibility (Model 1).** Device kind is fixed by hardware (handheld = pick, fixed station = pack). `role` is an **eligibility flag** — `both` = allowed at either kind. **No mode-chooser, no mid-shift toggle.** Gate = "is this worker eligible for this device's kind?"
- **"Select your name" only now; PIN-ready.** No PIN; `pin_hash` + worker-token-ready API so PIN is a later add with no rework.
- **RLS cutover deferred.** Not in this phase. Documented as a future task (§6), triggered only by a multi-shop owner account or a second login needing the same store.

### Reuse / current state (don't rebuild)
- `organizations`, `organization_members` (+ `is_org_member`, `is_org_owner`).
- `stores`, `store_members(role owner|operator|viewer)`, `pages`, helpers `can_access_store(uuid)`, `current_store()`.
- The 10 store-keyed-but-still-`user_id`-RLS tables (future cutover only): `live_sessions`, `live_auction_items`, `live_auction_item_skus`, `capture_events`, `order_payouts`, `synced_order_ids`, `entries`, `ad_spend`, `shipment_verifications`, `shop_videos`.
- Fulfillment (`fulfillment_orders`/`_lines`, `cubicles`, `pick_sections`) already **org-RLS** (037); inventory 4 tables **org-RLS** (035b).
- `set_updated_at()`, `uuid_generate_v4()` exist.

---

## 2. The two contexts

| | Store context | Fulfillment context |
|---|---|---|
| **Who** | Owners on their own machines | Shared warehouse devices (picker handheld, packer station) |
| **Auth** | **Existing per-store login, unchanged** | Shared org fulfillment account, provisioned per device, stays logged in |
| **Identity** | the store login | device session (fixed) **+** selected worker (per shift) |
| **Surface** | Full: dashboards, P&L, live capture, KPI dashboard (allowlisted) | Only `/pick` (picker device) or `/pack` (packer station), gated |
| **Roster** | n/a | "Select your name", filtered by device-kind eligibility |

---

## 3. Data model (schema additions — all additive)

### 3.1 `fulfillment_workers` — the roster  *(CHUNK 1)*
```
id        uuid pk
org_id    uuid not null → organizations(id) on delete cascade
name      text not null
role      text not null default 'both' check (role in ('picker','packer','both'))  -- eligibility flag (Model 1)
user_id   uuid null → auth.users(id) on delete set null    -- links an owner/person; most workers null
pin_hash  text null                                          -- FUTURE PIN (nullable now)
is_active boolean not null default true
created_at / updated_at
```
RLS: read `is_org_member(org_id)`; write **`is_store_owner_in_org(org_id)`** — a chunk-1 helper meaning "owns a store in this org" (both Alvaro & Abe), since `is_org_owner` is only the single org owner (excludes Abe) and `is_org_member` is too broad (would include the shared fulfillment device account + operators). `role` is eligibility, not a mode-chooser.

### 3.2 `fulfillment_devices` — provisioned devices  *(Q2: per-device deactivate only)*
```
id, org_id → organizations
kind              text check in ('picker','packer')   -- fixed by hardware
label             text
device_token_hash text not null                        -- minted at provisioning, stored hashed
provisioned_by    uuid → auth.users(id)
provisioned_at / last_seen_at
is_active         boolean default true                 -- revoke a lost device (v1: no remote end-all/rotation)
```
RLS: read `is_org_member`; create/deactivate gated to owners. Plaintext token only in device localStorage.

### 3.3 KPI attribution
```
fulfillment_lines.picked_by          uuid null → fulfillment_workers(id)
fulfillment_lines.picked_via_shift   uuid null → fulfillment_shifts(id)
fulfillment_orders.picked_by         uuid null → fulfillment_workers(id)   -- completed pick / assigned cubicle
fulfillment_orders.packed_by         uuid null → fulfillment_workers(id)
fulfillment_orders.packed_via_shift  uuid null → fulfillment_shifts(id)
```

### 3.4 `fulfillment_shifts` + `fulfillment_shift_breaks` — shift/break model
```
fulfillment_shifts
  id, org_id → organizations
  worker_id  uuid not null → fulfillment_workers(id)
  device_id  uuid null → fulfillment_devices(id)
  mode       text check in ('picker','packer')     -- = device.kind (no toggle)
  state      text check in ('working','on_break','ended')
  started_at timestamptz not null
  ended_at   timestamptz null
  end_reason text null check in ('manual','idle','break_timeout')
  created_at / updated_at

fulfillment_shift_breaks
  id, shift_id → fulfillment_shifts(id) on delete cascade
  started_at timestamptz not null
  ended_at   timestamptz null
```
**State machine:** `working ⇄ on_break`; `working|on_break → ended`.
- **Idle auto-end = 10 min** of no activity, **working-state only** (`end_reason='idle'`).
- **Break auto-cap = 60 min**: a break open >60 min ends the shift (`end_reason='break_timeout'`).
- **Active-time:** `(ended_at|now − started_at) − Σ(break durations)` → throughput = items ÷ active_time (breaks never penalize).
RLS: read/write `is_org_member(org_id)` (the device session manages its own shifts).

### 3.5 Fulfillment device principal
One shared **fulfillment** auth user per org, in `organization_members` (role `'fulfillment'`); org-RLS lets it use fulfillment tables; **no** `store_members` → no store surface. All devices use it; per-device revoke via `fulfillment_devices`.

### 3.6 KPI dashboard allowlist  *(Q8)*
- `org_settings.kpi_dashboard_store_ids uuid[]` (config row). Seeded with **lots-of-steals `afd1c76e-1d92-4c7d-9edf-0468ae7aa3df`** + **Snore `1d71a4c9-16b1-45f2-858e-64b41c548e9e`**.
- Dashboard renders only if the logged-in store login's `current_store()` ∈ that array → future shops don't auto-inherit it.

### 3.7 Store-login auth — **unchanged**  *(Q5/Q6/§0)*
No new store users, no migration. Existing per-store logins remain (each a `store_members` row; `current_store()` works). Only new auth artifact = the shared fulfillment account (3.5).

### 3.8 `profiles.account_type`  *(Q6: explicit column)*
`profiles.account_type text not null default 'store' check in ('store','fulfillment')`. Route guard: `store` → full surface; `fulfillment` → fulfillment context only.

---

## 4. Auth flows

**(a) Store login — unchanged.** Existing per-store credentials → full surface; `current_store()` = their store.

**(b) Device provisioning (one-time).** Unprovisioned device → Provision screen → owner authenticates + picks kind+label → backend inserts `fulfillment_devices`, mints token (returned once), logs device into shared org fulfillment account, stores `{token, device_id, kind}` in localStorage. Boots into fulfillment context thereafter.

**(c) Name-select + shift lifecycle.**
1. Roster = `fulfillment_workers` (org, active, **eligible for device kind**: picker device → `role in ('picker','both')`; packer → `('packer','both')`).
2. Tap name → open `fulfillment_shifts` (`working`, `mode=device.kind`). Client state `lensed.fulfillment.shift={shift_id,worker_id,name,mode}` (not a Supabase session). Route to `/pick`|`/pack`.
3. Header: "{name} · {mode}" + **Break** / **End shift**.
   - Break → `on_break` + open break row; scanning disabled. Resume → close break, `working`.
   - End shift → `ended`, `end_reason='manual'`; clear state; back to roster.
   - **Idle 10 min (working only)** → `ended`/`idle`. **Break >60 min** → `ended`/`break_timeout`.
4. PIN-ready: later, name-tap → PIN → server validates `pin_hash` → short-lived worker token the API requires instead of bare `worker_id`.

**(d) Role-gating (Model 1 eligibility).** Device kind fixed → device mounts only its screen; roster shows only kind-eligible workers; API requires device session (org RLS) + valid `worker_id`/open `shift_id` eligible for the kind, else 403.

**Identity tracking (crux):** device session (shared org account) *authorizes* writes via org RLS; client-held `worker_id`/`shift_id` is sent per action and *attributes* it (`picked_by`/`packed_by` + `*_via_shift`). Many workers, one session, per-person KPIs.

---

## 5. Per-store logins — no replacement needed
Keep the current per-store login model unchanged (one login per shop, §0). No new store or org-owner accounts. The only new auth artifact is the shared org fulfillment account. View-all switcher = optional chunk 12.

---

## 6. RLS cutover — **DEFERRED (future task, not this phase)**  *(Q9)*

Not built in chunks 1–12. Documented for when it's triggered.

- **Trigger:** a multi-shop owner account, or a **second login needing the same store** (i.e., when per-store logins stop being 1:1 with stores). Until then `user_id`-RLS ≈ `store_id`-RLS, so there is no functional gap.
- **Scope when triggered:** swap `user_id`→`can_access_store(store_id)` RLS on all **10** tables — **including `shipment_verifications` + `shop_videos`** (Q7: default include). **Precondition:** verify **0 NULL `store_id`** and every `store_id` resolves to an accessible store, on all 10, before swapping.
- **Helper:** if a multi-shop owner is introduced, extend `can_access_store` to grant org owners their org's stores (powers view-all); otherwise `store_members` suffices.
- **Sequencing:** all reads/writes store-aware (chunk 11) first; swap in one wrapped txn in a quiet window after a snapshot.
- **Rollback:** keep `user_id` columns + existing logins; reverse migration re-applies `user_id` policies. Treat as point-of-no-return operationally; reversible technically.

---

## 7. Active build order (chunks 1–11, + optional 12; NO 13)

| # | Chunk | Depends on | Reversible? |
|---|---|---|---|
| **1** | **Roster model** — `fulfillment_workers` (+ RLS) | — | ✅ pure addition |
| 2 | Owner roster UI — add/remove workers, assign role/eligibility (store context) | 1 | ✅ |
| 3 | Attribution columns — `picked_by`/`packed_by` (+ `*_via_shift`) | 1 | ✅ additive |
| 4 | Shift/break model — `fulfillment_shifts` + `fulfillment_shift_breaks` | 1 | ✅ additive |
| 5 | Stamp attribution + shift linkage in endpoints | 3,4 | ✅ (nullable; old calls work) |
| 6 | Device model + provisioning — `fulfillment_devices`, shared org fulfillment account, provisioning flow + token | 1 | ✅ |
| 7 | Fulfillment shell — name-select → start shift; Break/Resume/End; idle-10m + break-cap-60m; device-kind eligibility gating | 4,6 | ✅ |
| 8 | Wire shift → `/pick` & `/pack` — pass `worker_id`/`shift_id`; header break/end | 5,7 | ✅ |
| 9 | Worker-KPI dashboard — org-wide, active-time = total − breaks, allowlisted (`org_settings.kpi_dashboard_store_ids`) | 3,4,5 | ✅ additive |
| 10 | `profiles.account_type` + route-guard branching (store vs fulfillment) | 6 | ✅ |
| 11 | Store-aware app code — operational/financial writes carry `store_id` (hygiene; also future-cutover prep) | — | ✅ |
| 12 | *(optional)* View-all switcher — cross-store org view | 11 | ✅ nice-to-have |

- **All chunks reversible/additive.** Existing logins + `user_id`-RLS remain authoritative. **No point-of-no-return in this phase** (the cutover, §6, is deferred).

---

## 8. Open questions — ALL RESOLVED (rev 3)

- **Q2 lost device** → per-device `is_active=false` only for v1; no remote end-all/rotation. ✅
- **Q3 idle** → **10 min** auto-end, working-state only. ✅
- **Q4 forgotten break** → auto-cap at **60 min** → end shift (`end_reason='break_timeout'`). ✅
- **Q5 "both"** → Model 1: device kind fixed by hardware; `role` = eligibility (`both` = either kind); no mode-chooser, no mid-shift toggle. ✅
- **Q6 account_type** → explicit `profiles.account_type` column. ✅
- **Q7 shipment_verifications + shop_videos** → include in the future cutover with the other 8; verify clean `store_id`/no-nulls before that cutover. ✅
- **Q8 KPI allowlist** → `org_settings.kpi_dashboard_store_ids uuid[]` = [lots-of-steals `afd1c76e…`, Snore `1d71a4c9…`]. ✅
- **Q9 RLS cutover** → **deferred** out of this phase (§6); future task, trigger = multi-shop owner or second login per store. ✅
- (Earlier #1 device principal, #10 PIN, #11 fulfillment account — resolved in rev 2.) ✅

No open questions remain. **Ready to build chunk 1.**

---

*End of rev 3 (final). On your go: build chunk 1 only — migration `039_fulfillment_workers.sql` shown for editor review first (036/037/038 discipline), you apply + confirm, then any chunk-1 app code. No building ahead of chunk 1.*
