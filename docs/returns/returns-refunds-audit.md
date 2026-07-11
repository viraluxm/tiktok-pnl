# TikTok Shop Returns / Refunds / Claims / Support — Audit Report

**Scope:** Audit only. No feature built. No TikTok write endpoints called. No real return/refund/claim/order data mutated. No secrets printed. Audit script created (read-only, isolated, uncommitted, not run). Nothing committed.

**Date:** 2026-06-30 · **App:** Lensed (`tiktok-pnl-v2`, Next.js 16 + Supabase) · **Repo:** viraluxm/tiktok-pnl

Method: parallel codebase readers + TikTok Shop Partner API v2 doc research, each finding adversarially re-verified against the EcomPHP/tiktokshop-php SDK and official docv2 page slugs. API-claim reliability came back **high** (docv2 pages are JS-rendered and not directly fetchable, so exact request-body field names / enum casing are name-level, not byte-verified — flagged inline).

---

## 0. Headline (read this first)

**The returns/refunds/cancellations feature already exists and is LIVE — including write actions.** This is not a greenfield build. The framing "no accept/reject in V1, only after API confirmation" describes a state we are already past.

- List + summary + "awaiting seller action": `GET /api/tiktok/returns`
- **Approve / reject (real TikTok writes): `POST /api/tiktok/returns/respond`**, wired to a "Respond → Issue Refund / Reject" modal in the dashboard **Returns** tab. A logged-in user can issue a real refund today.

Three **safety gaps in the code that already ships**:
1. **No role gate** on the write route — only `supabase.auth.getUser()`; any authenticated user with a connection can approve refunds. ([respond/route.ts:8-10](../src/app/api/tiktok/returns/respond/route.ts))
2. **No audit log** of who approved/rejected what (only `console.error` on failure). Violates the stated requirement "all write actions must be logged."
3. **Reject reasons are hardcoded free-text** (`"Product has been shipped"`, …) instead of TikTok's enumerated codes from `Get Reject Reasons`. Rejects may be malformed/failing. ([ReturnsTab.tsx:31-36](../src/components/dashboard/ReturnsTab.tsx))

Plus a **secret-handling bug**: the OAuth token exchange `console.log`s the full raw token response (access_token + refresh_token in cleartext) to server/Vercel logs. ([client.ts:49-52](../src/lib/tiktok/client.ts))

Conclusion: the real work is **(a) harden what already runs, then (b) productize a proper triage workflow** on top of a richer-than-expected API — not "prove feasibility."

---

## 1. Current TikTok API access

### 1.1 Credentials & config (values never read)
| Env var | Required in `env.ts`? | In `.env.local`? | Purpose |
|---|---|---|---|
| `TIKTOK_SHOP_APP_KEY` | ✅ | ✅ | Shop app key (signed query param) |
| `TIKTOK_SHOP_APP_SECRET` | ✅ | ✅ | OAuth secret **and** HMAC signing key |
| `ENCRYPTION_KEY` | ✅ | ✅ | AES-256-GCM key (32-byte hex) for token-at-rest |
| `TIKTOK_SHOP_SERVICE_ID` | ❌ (lazy `''`) | ❌ **absent** | Builds Shop OAuth authorize URL |
| `TIKTOK_BUSINESS_APP_ID` / `_SECRET` | ❌ (lazy `''`) | ❌ absent | Separate Ads API (unrelated to returns) |
| `NEXT_PUBLIC_SITE_URL` | ❌ | ❌ absent | Business OAuth redirect_uri |

⚠️ `TIKTOK_SHOP_SERVICE_ID` is read via `process.env` with an empty-string fallback and is **not** validated at startup, and is absent locally. If unset in prod too, the Shop connect flow silently fails at TikTok's consent screen (authorize URL has `service_id=`). Confirm it's set in Vercel. ([client.ts:13-25](../src/lib/tiktok/client.ts), [env.ts](../src/lib/env.ts))

### 1.2 Scopes / permissions model
TikTok Shop does **not** use per-request OAuth scopes. The code passes only `service_id + state` to the authorize URL (no scope list) — **confirmed**. Granted permissions are configured **once at the app level in TikTok Partner Center** and consented by the seller at connect time; the granted set is surfaced on the token-exchange response, not per call. **Implication:** returns read + write already work in code, so the app's Partner Center config **already includes the "Return and Refund" + "Order" permission groups** (or the existing approve/reject writes would fail). There is no separate "list my granted scopes" API — read it from the token response or Partner/Seller Center.

### 1.3 Capability checklist — what we have vs. what's possible
Legend: **DONE** = wired in code today · **AVAIL** = TikTok API supports it, not implemented · **NO-API** = Seller Center only.

| Capability | Status | Endpoint / note |
|---|---|---|
| List return requests | **DONE** | `POST /return_refund/202309/returns/search` (`fetchReturns`) |
| List cancellations | **DONE** | `POST /return_refund/202309/cancellations/search` (`fetchCancellations`) |
| Return/refund **detail + timeline** | **AVAIL** | `GET /return_refund/202309/returns/{id}/records` (buyer/seller notes, images, buyer videos) |
| **Return reasons / reject-reason codes** | **AVAIL** | `GET /return_refund/202309/reject_reasons?return_or_cancel_id=…&locale=…` ⚠️ *namespace root, not under `returns/`* |
| Accept a return/refund | **DONE** | `POST …/returns/{id}/approve` (currently empty body) |
| Reject a return/refund | **DONE** (buggy reasons) | `POST …/returns/{id}/reject` (needs codes from reject_reasons) |
| Accept/reject cancellation | **DONE** | `POST …/cancellations/{id}/approve|reject` |
| Seller notes on reject | **DONE (partial)** | `comment` supported; evidence `images[]` unconfirmed in body |
| Refund **without** return | **AVAIL** | Approve with `buyer_keep_item=true`, or create return `type=REFUND` |
| Require return before refund | **AVAIL/default** | `type=RETURN_AND_REFUND` |
| **Partial** refund | **AVAIL** | `partial_refund{amount}` on approve + `POST …/refunds/calculate` to preview |
| Replacement / wrong-item | **AVAIL** | `type=REPLACEMENT` (TikTok generates a new order on accept) |
| Eligibility pre-check | **AVAIL** | `GET …/orders/{order_id}/aftersale_eligibility` |
| Seller-response **deadlines / SLA** | **AVAIL** | `seller_next_action_response[].{action,deadline}` on each return; 48h auto-approve-in-buyer-favor |
| Arbitration / dispute state | **AVAIL** | `arbitration_status` field (IN_PROGRESS / SUPPORT_BUYER / SUPPORT_SELLER / CLOSED) — status only, no separate API |
| View buyer evidence (images/video) | **AVAIL (likely)** | via return records; exact field names unverified — confirm live |
| Upload **seller** dispute evidence | **NO-API** | Seller Center only (24h evidence window) |
| Request more info from buyer | **NO-API** | Seller Center / chat only |
| Escalate / appeal arbitration | **NO-API** | Seller Center only |
| Buyer messaging (send/receive) | **AVAIL, gated** | Customer Service API (`/customer_service/202309/…`) — **approval-gated** (see §4C) |
| Real-time return events | **AVAIL** | Webhooks: Return Status Change (type 12), Cancellation Status Change |
| Order-level context (buyer/recipient) | **DONE (reads exist)** | `POST /order/202309/orders/search`, `GET /order/202309/orders?ids=` |

---

## 2. Existing app/API structure

- **All TikTok Shop calls live in [`src/lib/tiktok/client.ts`](../src/lib/tiktok/client.ts)** (server-only). A separate [`business-client.ts`](../src/lib/tiktok/business-client.ts) is the **Ads** API (different host `business-api.tiktok.com`, `Access-Token` header, **no** HMAC) — unrelated to returns; do not extend it for support work.
- **Auth/signing helper pattern:** every signed call goes through `shopGet(path, token, extraParams)` / `shopPost(path, token, body, extraParams)`. Signature = `HMAC-SHA256(key=app_secret)` over `app_secret + path + sortedParams(key+value, excl. sign/access_token) + body + app_secret`; token via `x-tts-access-token` header; `shop_cipher` threaded as a query param; base `https://open-api.tiktokglobalshop.com`. **Verified correct** against the signing doc + SDK.
- **OAuth:** `getAuthUrl` (authorize, service_id) → `exchangeCodeForToken` (`auth.tiktok-shops.com/api/v2/token/get`) → `getAuthorizedShops` (resolve `shop_cipher`) → upsert encrypted tokens. `refreshAccessToken` exists but **is not auto-triggered** on the returns path (tokens are used directly via `decryptOrFallback` without checking `token_expires_at`).
- **Best place to add return/refund/claim wrappers:** `client.ts`, under the existing `RETURNS / CANCELLATIONS` (line ~625) and `RETURN/CANCELLATION ACTIONS` (line ~823) sections — new reads = `shopGet`, writes = `shopPost`; signing/headers/errors are centralized.
- **Connection storage** (`tiktok_connections`, per-user, RLS): `access_token` (enc), `refresh_token` (enc), `token_expires_at`, `shop_cipher` (plaintext), `shop_name`, `advertiser_ids`, timestamps. **We already store enough to call the APIs** (`access_token` + `shop_cipher`). **Not stored:** `open_id`, `seller_name`, region, numeric `shop_id` (discarded from token/`getAuthorizedShops`).
- **Should it be part of the existing connection flow?** Yes — no new scopes/connection needed for returns/refunds/cancellations (already granted, since writes are coded). New scopes **would** be needed only for **Customer Service messaging** (separate, approval-gated).
- **Gating & tenancy:** `(app)` routes protected by client layout + edge middleware; `/admin/*` gated by `app_metadata.role === 'admin'` (server layout). Connection is strictly **per-user** (035b lists `tiktok_connections` as user-owned; only inventory/products/costs are org-shared). Returns are per-user today; org-sharing later would need a new org-scoped table following the 035b `org_id` + `set_org_id_on_insert` + `is_org_member` RLS pattern.

---

## 3. Safe API capability test

Created **[`scripts/audit/returns-capability-probe.ts`](../scripts/audit/returns-capability-probe.ts)** — read-only, isolated, uncommitted, easy to delete.

- Calls **only** search/list/get/detail. Never approve/reject/refund/cancel/create (those are documented at the bottom as "NOT CALLED"; `refunds/calculate` deliberately skipped as action-shaped).
- Reuses the exact signing scheme + AES-GCM token format (inlined so it's self-contained; auto-loads `.env.local`).
- Loads `access_token` + `shop_cipher` from `tiktok_connections` via service role, decrypts, then probes: `authorization/shops` (token sanity), `returns/search`, `cancellations/search`, and — if a record exists — `returns/{id}/records`, `reject_reasons` (correct `return_or_cancel_id` param), `orders/{order_id}/aftersale_eligibility`, `order detail`.
- Prints a summary table: `REACHABLE (n)` / `EMPTY (0 records)` / `DENIED/ERROR http+code+msg` / `SKIPPED`. **Redacts all secrets.** Typechecks clean.

Run: `npx tsx scripts/audit/returns-capability-probe.ts` (`--user <uuid>`, `--days 180`).

### 3.1 Live probe results (RAN 2026-06-30, read-only)
Two connected shops found in `tiktok_connections`: **"Snore."** and **"lotsofsteals"**. Both produced identical results:

| Endpoint | Result |
|---|---|
| `GET /authorization/202309/shops` | ✗ `http=401 code=105001 "access token is invalid"` |
| `POST /return_refund/202309/returns/search` | ✗ `http=401 code=105001 "access token is invalid"` |
| `POST /return_refund/202309/cancellations/search` | ✗ `http=401 code=105001 "access token is invalid"` |
| records / reject_reasons / eligibility | SKIPPED (search returned no records to key off) |

**Root cause = local environment, not TikTok access.** A strict AES-GCM decrypt of the stored `access_token` **failed the auth-tag check** → the local `.env.local` `ENCRYPTION_KEY` does **not** match the key that encrypted these (production) rows. So the app's `decryptOrFallback` returned the raw ciphertext and the probe sent *ciphertext* as the token → TikTok correctly rejected it as invalid. This is a local-only limitation.

What the run **does** establish:
- **Signing + app_key/app_secret are valid** — TikTok returned a *token* error (`105001`), not a *signature* error, so the request was well-formed and correctly signed.
- **No scope/permission denial was observed** — `105001` is authentication, not authorization; we cannot assess granted scopes until a *valid* token can be presented.
- **A second, code-level bug is confirmed:** `token_expires_at` is stored as **year 2082** because [callback/route.ts:64](../src/app/auth/tiktok/callback/route.ts) does `Date.now() + access_token_expire_in*1000`, but TikTok returns `access_token_expire_in` as an **absolute epoch**, not a duration. Effect: any expiry-gated refresh never fires.

**To get live worked/denied/empty results**, re-run the probe in an environment that has the **production `ENCRYPTION_KEY`** (e.g. a Vercel preview/prod shell) or after reconnecting a shop with the current key. The probe itself is correct and ready.

---

## 4. Feature feasibility

### A. Returns/claims dashboard — ✅ fully feasible
Available per-return fields: `return_id`, `order_id`, `return_type` (REFUND / RETURN_AND_REFUND / REPLACEMENT), `return_status` (enum: `RETURN_OR_REFUND_REQUEST_PENDING`, `AWAITING_BUYER_SHIP`, `BUYER_SHIPPED_ITEM`, `REJECT_RECEIVE_PACKAGE`, `RETURN_OR_REFUND_REQUEST_SUCCESS/COMPLETE/REJECT/CANCEL`, `AWAITING_BUYER_RESPONSE`), `arbitration_status`, `refund_amount` breakdown (total/subtotal/shipping/tax/fees), `return_line_items[]` (`sku_id`, `sku_name`, `seller_sku`, `product_name`, `product_image`, qty, per-line refund), `return_reason`/`_text`, `buyer_remarks`, `seller_next_action_response[]` (action + **deadline**), timestamps, reverse-logistics fields.
- Order # ✓ · SKU/item ✓ · reason ✓ · return status ✓ · amount ✓ · **deadline ✓** · TikTok-required action ✓
- **Buyer identity ✗ (limited):** returns expose no buyer name/contact (only filter by `buyer_user_ids`); pull recipient/contact from the Order API when needed.
- **Refund status:** not a separate field — it's encoded in `return_status` + `arbitration_status`. The current UI collapses everything into one `status`.

### B. Return/refund decision actions
| Action | Feasible? |
|---|---|
| Accept | ✅ (implemented) |
| Reject | ✅ (implemented; **must** switch to `reject_reasons` codes) |
| Rejection reason + seller note | ✅ (`reject_reason` code + `comment`) |
| Request more info from buyer | ❌ no API (Seller Center/chat) |
| Escalate / dispute / counterclaim | ❌ no API — `arbitration_status` is read-only; appeals in Seller Center |
| Refund **without** return | ✅ `buyer_keep_item` / create `type=REFUND` |
| Require return before refund | ✅ default `RETURN_AND_REFUND` |
| Partial refund | ✅ `partial_refund` + `refunds/calculate` |
| Wrong-item / replacement | ✅ `type=REPLACEMENT` (new order generated on accept) |

### C. Messaging / templates
- **Direct buyer messaging via API: possible but approval-gated.** Customer Service API (`GET/POST /customer_service/202309/conversations[/{id}/messages]`, `images/upload`, `agents/settings`) exists and is confirmed. But CS scope requires **1000+ authorized sellers OR high API volume**, and applicants must **already ship an in-app chat UI** to qualify. For a small-seller tool this is likely **blocked initially**.
- Conversations are **order-scoped** (create against `order_id`); no direct `return_id` binding — join on `order_id`.
- **Fallback = message templates + copy-to-clipboard.** Recommended for V1 regardless. Template storage → new `message_templates` table (see §5).

### D. Evidence / attachments
- **View buyer evidence:** likely yes via `returns/{id}/records` (`images[]`, `videos[]`) — exact field names unverified; confirm with the probe/live.
- **Upload seller evidence: no public API.** Seller Center only, with a 24h window. (The only image-upload endpoint is CS chat's, not returns.)
- File type/size limits: not documented via API.

### E. Operational deadlines / statuses — ✅ strong
- **Deadlines exposed:** `seller_next_action_response[].deadline` (Unix) + global **48h auto-approve-in-buyer's-favor**. Sort the queue by time-to-deadline to surface urgency.
- **Categorize:** Needs seller action (`…_PENDING` / `seller_next_action` present) · Waiting for buyer return (`AWAITING_BUYER_SHIP` / `BUYER_SHIPPED_ITEM`) · TikTok reviewing (`arbitration_status=IN_PROGRESS`) · Refunded (`…_SUCCESS/COMPLETE`) · Rejected (`…_REJECT`).
- **Real-time:** subscribe to Return/Cancellation Status Change webhooks (needs only the return_refund scope — no CS gating) → biggest lever for a "faster" workflow vs. polling.

---

## 5. Data model proposal (no migrations yet)

Multi-tenant decision first: **user-scoped** (matches `tiktok_connections` today) or **org-scoped** (035b pattern) — recommend user-scoped for V1, structured so `org_id` can be added later.

- **`tiktok_returns`** (cache/queue): `id`, `user_id`, `return_id` UNIQUE, `order_id`, `return_type`, `return_status`, `arbitration_status`, `refund_amount` numeric, `refund_breakdown` jsonb, `currency`, `reason_code`, `reason_text`, `buyer_remarks`, `next_action` text, `next_action_deadline` timestamptz, `is_combined` bool, `raw` jsonb, `tiktok_create_time`, `tiktok_update_time`, `last_synced_at`. Indexes on `(user_id, next_action_deadline)`, `(user_id, return_status)`.
- **`tiktok_return_line_items`**: `return_id` FK, `order_line_item_id`, `sku_id`, `sku_name`, `seller_sku`, `product_id`, `product_name`, `product_image`, `quantity`, refund breakdown.
- **`tiktok_return_records`** (timeline): `return_id` FK, `event`, `role`, `reason_text`, `note`, `images` jsonb, `videos` jsonb, `tiktok_create_time`.
- **`return_status_history`**: `return_id`, `old_status`, `new_status`, `source` (webhook/poll), `changed_at`.
- **`return_action_log`** (⭐ audit trail — required): `id`, `actor_user_id`, `return_id`, `action` (approve/reject/partial_refund/…), `decision`, `reject_reason_code`, `seller_comments`, `idempotency_key`, `request_summary` jsonb (redacted), `tiktok_response` jsonb, `result` (success/failed), `created_at`.
- **`message_templates`**: `id`, `user_id`/`org_id`, `name`, `category` (approved/rejected/info_request/replacement/…), `body`, `variables` jsonb, `created_by`, `updated_at`.
- **`return_internal_notes`**: `return_id`/`order_id`, `user_id`, `note`, `created_at`.
- *(optional)* **`generated_replies`**: `return_id`, `template_id`, `rendered_text`, `created_by`, `created_at`.
- *(optional)* **`webhook_events`**: `event_type`, `shop_id`, `payload` jsonb, `received_at`, `processed_at` (dedupe/replay).

---

## 6. UX proposal (V1)

- **Page:** promote the Returns tab into a first-class **Customer Support** page (`(app)/support` for sellers, or `(app)/admin/support` if staff-only) — keep the dashboard tab as an entry point.
- **Claims list:** default sort **by deadline ascending**; filter tabs mirroring the status buckets in §4E; columns = deadline countdown · order# · buyer (order-join) · SKU + image · type · reason + buyer remark · status badge · refund amount · action.
- **Claim detail drawer/page:** full **timeline** (`records`), **buyer evidence thumbnails**, order/recipient context, refund breakdown, **eligibility** + **calculate-refund preview**, suggested **templates (copy-to-clipboard)**, and action buttons.
- **Actions:** approve / reject with **correct reject-reason codes**, explicit confirm dialog, mandatory internal note → **every action logged** to `return_action_log` with an idempotency key.
- **Fallbacks:** copy-to-clipboard templates first; **"Open in Seller Center"** deep-links for the no-API gaps (upload evidence, request buyer info, appeal arbitration).

---

## 7. Security / safety — requirements vs. current state

| Requirement | Current state |
|---|---|
| No automatic accept/reject/refund in V1 | ⚠️ Manual-but-live approve/reject already ships (has confirm dialog; no automation) |
| Write actions require explicit click + confirmation | ✅ two-step modal exists |
| All write actions logged | ❌ **not met** — no audit record |
| Never expose tokens in client/logs | ❌ **raw token response is `console.log`'d** at token exchange |
| Server-side only TikTok calls | ✅ both clients are server-only; no `NEXT_PUBLIC_` secret leakage |
| Respect existing auth/admin/seller gating | ⚠️ returns routes gate on auth only — **no role check** |
| (Add) idempotency on writes | ❌ not present; TikTok write endpoints expect `idempotency_key` |

---

## 8. Risks / blockers

1. **Live, under-gated write path today** — no role gate, no audit log, no idempotency; **hardcoded (wrong) reject reasons**. Highest priority to harden.
2. **Secret exposure** — token response logged in cleartext ([client.ts:49-52](../src/lib/tiktok/client.ts)); also `app_secret` travels in the token-exchange URL (refresh already hardened to POST body).
3. **`TIKTOK_SHOP_SERVICE_ID`** absent locally + unvalidated — confirm it exists in prod or connect is broken.
4. **CS messaging approval gate** — likely blocks live buyer messaging for a small-seller tool; plan on templates.
5. **No API** for seller evidence upload / request-more-info / arbitration appeal — must deep-link to Seller Center.
6. **48h SLA** — a truly "fast" workflow wants webhooks; polling risks missing the window.
7. **Doc precision** — exact request-body field names / enum casing (`buyer_keep_item`, `partial_refund`, type enums, evidence field names) are name-level, not byte-verified (docv2 is JS-rendered). Confirm via the probe against a live 202309 response before writing new mutations.
8. **Token refresh** not triggered on the returns path — writes can fail on expired tokens.
9. **Single connection per user** (`upsert onConflict:'user_id'`) — multi-shop support would be a schema change.
10. **Token-expiry mis-calculation** ([callback/route.ts:64](../src/app/auth/tiktok/callback/route.ts)) stores `token_expires_at` ≈ year 2082 (treats TikTok's absolute-epoch `access_token_expire_in` as a duration). Any refresh gated on expiry will never fire → tokens silently go stale. **Confirmed via live probe.**
11. **`ENCRYPTION_KEY` mismatch between environments** — the local `.env.local` key can't decrypt the production token rows (GCM auth-tag failure). Confirms tokens are env-locked; if prod's key was ever rotated without re-minting tokens, prod itself would hit `105001`. Verify the deployed key matches the key those rows were encrypted with.

---

## 9. Recommended V1 scope + implementation plan (pending approval — not started)

**Phase 0 — Harden the feature that already ships (do first, small):**
- Add admin/seller role gate + `return_action_log` audit trail + `idempotency_key` to `returns/respond`.
- Replace hardcoded reject reasons with `Get Reject Reasons` (`/return_refund/202309/reject_reasons`).
- Remove the raw-token `console.log`; trigger `refreshAccessToken` when `token_expires_at` is near.

**Phase 1 — Triage workflow (read-heavy, safe):**
- New `client.ts` wrappers (reads): `getReturnRecords`, `getRejectReasons`, `getAftersaleEligibility`, `calculateRefund`.
- New tables: `tiktok_returns` (+ line items + records), `return_action_log`, `message_templates`, `return_internal_notes`.
- `/support` page: deadline-sorted queue, status-bucket filters, detail drawer with timeline + buyer evidence + copy-to-clipboard templates + Seller Center deep-links. Writes stay behind confirm + log.

**Phase 2 — Richer decisions:** partial refund, return-less refund (`buyer_keep_item`), replacement handling, seller-initiated create.

**Phase 3 — Real-time + messaging:** Return/Cancellation Status Change webhooks; Customer Service messaging **if** approval is obtained, else keep templates + deep-links.

---

## Appendix A — Files inspected
`src/lib/tiktok/client.ts`, `src/lib/tiktok/business-client.ts`, `src/lib/env.ts`, `src/lib/crypto.ts`, `src/lib/org.ts`, `src/lib/supabase/{admin,server,client,middleware}.ts`,
`src/app/api/tiktok/returns/route.ts`, `src/app/api/tiktok/returns/respond/route.ts`, `src/app/api/tiktok/{auth,status,disconnect,sync}/route.ts`, `src/app/auth/tiktok/callback/route.ts`, `src/app/api/tiktok-business/*`,
`src/hooks/useReturns.ts`, `src/components/dashboard/ReturnsTab.tsx`, `src/components/tiktok/TikTokConnect.tsx`, `src/app/(app)/dashboard/RealDashboard.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/admin/layout.tsx`,
`supabase/migrations/{002,005,008-011,016,020,032,035b,036}*.sql` (+ grep of all migrations for return/refund/claim/dispute/cancel/reverse → **no returns table exists**).

## Appendix B — Endpoints found (implemented) & researched (available)
**Implemented reads:** `authorization/202309/shops`, `order/202309/orders/search`, `order/202309/orders` (by ids), `finance/202309/{statements,payments,settlements}`, `finance/{202507,202309}/orders/unsettled`, `product/202309/products/search` + `/{id}`, `analytics/202509/shop_videos/performance`, `return_refund/202309/returns/search`, `return_refund/202309/cancellations/search`.
**Implemented writes:** `return_refund/202309/returns/{id}/{approve,reject}`, `return_refund/202309/cancellations/{id}/{approve,reject}`, `product/202309/products/{id}/inventory`.
**Available, not implemented:** `return_refund/202309/returns/{id}/records`, `return_refund/202309/reject_reasons`, `return_refund/202309/refunds/calculate`, `return_refund/202309/orders/{order_id}/aftersale_eligibility`, `return_refund/202309/returns` (create), `return_refund/202309/cancellations` (create); Customer Service `/customer_service/202309/*` (gated); Return/Cancellation Status Change webhooks.
**Corrections captured in verification:** `reject_reasons` is at the namespace root (not `returns/reject_reasons`); single-return detail = `records` (there is no `GET /returns/{id}`); token TTLs (~7d/~30d) unverified — read the expiry epoch from the token response.
