# Return/Refund/Claim DETAIL Capability — Deep-Dive (read-only audit)

**Question:** Can we build a TikTok-Seller-Center-style return/refund/claim **detail + interaction** experience inside Lens?
**Short answer: Yes — the *viewing* experience can be built to near-parity, and the core *decisions* (approve/reject/refund/partial/return-less/replacement→refund) are fully API-backed. The gaps are all on the *outbound interaction* side: no free-form seller comment outside a reject, no "request info from buyer," no dispute/appeal evidence upload, and live buyer chat is approval-gated.**

**Confidence:** field names + enums below are **high** (cross-verified across the lazykern raw spec JSON, the phamconganh TypeScript SDK models, and the EcomPHP SDK). **Not live-confirmed** on our shop — the local `ENCRYPTION_KEY` can't decrypt the stored tokens, so the probe returns `105001` regardless; that is a local-env limitation, not an API denial. Anything needing a live token is flagged.

---

## 1. Two reads build the whole detail view
There is **no** `GET /returns/{id}` detail endpoint. A Seller-Center-style detail screen = **two calls**:
- **Header/state** → `POST /return_refund/202309/returns/search` with `return_ids:[id]`
- **Timeline + evidence** → `GET /return_refund/202309/returns/{return_id}/records`

---

## 2. Capability matrix

| Capability | Verdict | Endpoint / field |
|---|---|---|
| **Customer reason (code + text)** | ✅ API-supported | `return_orders[].return_reason` (code) + `return_reason_text` (localized). Return-level only — no per-line reason. |
| **Customer written explanation** | ✅ API-supported | `records[].note` where `records[].role == BUYER` (Get Return Records). No dedicated `buyer_remarks` field. |
| **Return type / refund type** | ✅ API-supported | `return_orders[].return_type` = `REFUND` / `RETURN_AND_REFUND` / `REPLACEMENT` |
| **Customer-uploaded images** | ✅ API-supported (proxy URLs) | `records[].images[]{url,width,height}` |
| **Customer-uploaded video** | ✅ API-supported (proxy URLs) | `records[].videos[]{url,cover,width,height,duration_millis}` (buyer-only) |
| — image/video URL nature | ⚠️ Docs-say-but-not-confirmed | Images look public/unsigned (ibyteimg CDN, only `?from=`); videos on `akamaized.net` likely **signed/expiring**. **Proxy through our backend + re-fetch; don't persist raw URLs.** |
| **Full timeline/history** | ✅ API-supported (with caveat) | `records[]` = `{event, role, description, reason_text, note, create_time, images[], videos[]}`. **`event` is always the constant `ORDER_RETURN`** → derive steps from `role`+`description`+`create_time`, not from `event`. Not paginated. |
| **Lifecycle status** | ✅ API-supported | `return_status` (14 values) + `arbitration_status` (4 values) from Search Returns |
| **SLA / next action + deadline** | ✅ API-supported | `seller_next_action_response[]{action,deadline(unix)}` |
| **Refund money breakdown** | ✅ API-supported | `refund_amount{currency,refund_total,refund_subtotal,refund_shipping_fee,refund_tax,retail_delivery_fee,buyer_service_fee}` at return + line level; plus `discount_amount[]`, `shipping_fee_amount[]` |
| **Return tracking / logistics** | ✅ API-supported | `return_tracking_number`, `return_provider_name/id`, `shipment_type`, `handover_method`, `return_method`, `return_warehouse_address` |
| **Reject-reason codes** | ✅ API-supported | `GET /return_refund/202309/reject_reasons?return_or_cancel_id=…&locale=…` → `reasons[]{name,text}` (per-return, **not** a static list) |
| **Approve / reject / refund** | ✅ API-supported (writes) | see §4 (out of this audit's scope to *call*, but fully available) |
| **Seller comment (standalone)** | ❌ Not supported by API | Only `comment` bound to **Reject Return**. Approve has no comment. No standalone note action. |
| **Request more info from buyer** | ❌ Not supported by API | Seller Center / chat only |
| **Seller evidence upload (dispute)** | ⚠️ Partial → mostly Seller Center only | Reject can attach `images[]{image_id,…}` sourced from `POST /product/202309/images/upload`. **No video/doc; approve can't attach; full arbitration/appeal evidence = Seller Center only.** |
| **Buyer messaging (chat)** | 🔒 Requires TikTok approval | Customer Service API — approval-gated (see §5) |
| **Buyer name / contact** | ❌ Not on return object | Only `buyer_user_ids` as a *filter input*; identity/contact must come from the Order API or CS API |
| **product_id / quantity on return line** | ❌ Not on return object | Join from the Order API line items if needed |

---

## 3. Exact endpoints needed (all READ except §4)
| Purpose | Method + path | Notes |
|---|---|---|
| Return header/state | `POST /return_refund/202309/returns/search` | envelope `data.return_orders[]`, `total_count`, `next_page_token` |
| Timeline + evidence | `GET /return_refund/202309/returns/{return_id}/records` | not paginated; `locale` param localizes `reason_text` |
| Reject reason codes | `GET /return_refund/202309/reject_reasons` | `return_or_cancel_id` (req) + `locale` |
| Eligibility (which actions valid) | `GET /return_refund/202309/orders/{order_id}/aftersale_eligibility` | pre-gate action buttons |
| Refund preview | `POST /return_refund/202309/refunds/calculate` | compute, no mutation |
| Cancellations queue | `POST /return_refund/202309/cancellations/search` | pre-ship cancels |
| Order/buyer enrichment | `POST /order/202309/orders/search`, `GET /order/202309/orders?ids=` | buyer/recipient, qty, product_id |
| Seller evidence image source | `POST /product/202309/images/upload` | returns `image_id` for reject `images[]` |
| Buyer chat (gated) | `/customer_service/202309/conversations…/messages`, `…/images/upload` | see §5 |

---

## 4. Actions available vs. not (interaction surface)
**Available via API (writes — already partly implemented in the app):**
- **Approve** `POST …/returns/{id}/approve` — `decision` ∈ `{APPROVE_REFUND, APPROVE_RETURN, APPROVE_RECEIVED_PACKAGE, APPROVE_REPLACEMENT, ISSUE_REPLACEMENT_REFUND, OFFER_PARTIAL_REFUND, DIRECT_REFUND}`; `buyer_keep_item` (returnless); `partial_refund{currency,amount}`. **"Refund without return" = `DIRECT_REFUND` (or `buyer_keep_item`).**
- **Reject** `POST …/returns/{id}/reject` — `decision` ∈ `{REJECT_REFUND, REJECT_RETURN, REJECT_RECEIVED_PACKAGE, REJECT_REPLACEMENT}` + `reject_reason` (code from reject_reasons) + optional `comment` + optional `images[]{image_id,mime_type,width,height}`. `idempotency_key` supported.
- Cancellation approve/reject; seller-initiated create return/cancel.

**NOT available via API (Seller Center only):**
- Standalone seller comment / note (no decision).
- "Request more information from buyer."
- Seller **video/document** evidence; any evidence on approve; full **arbitration/appeal** evidence submission.
- Escalate / counter / appeal an arbitration ruling (`arbitration_status` is read-only).

---

## 5. Replacement / wrong-item — fully representable
- `return_type = REPLACEMENT`; buyer-initiated (`REPLACEMENT_REQUEST_PENDING`); seller acts via `SELLER_RESPOND_REPLACEMENT`.
- Seller options: `APPROVE_REPLACEMENT`, **`ISSUE_REPLACEMENT_REFUND` ("can't replace → refund instead")**, `OFFER_PARTIAL_REFUND`, `DIRECT_REFUND`, or `REJECT_REPLACEMENT`.
- Accepting generates a **new order to reship** (`REPLACEMENT_REQUEST_COMPLETE`); auto-falls back to refund if out of stock (`REPLACEMENT_REQUEST_REFUND_SUCCESS`).
- "Cannot replace but can refund" is a **first-class structured action** (`ISSUE_REPLACEMENT_REFUND`); a free-text explanation to the buyer needs Reject's `comment` or the gated CS chat.

---

## 6. Customer Service (buyer messaging) — approval-gated
- Endpoints exist: `GET/POST /customer_service/202309/conversations`, `…/{id}/messages`, `POST …/images/upload`, agent settings.
- **Gating (double):** (1) API access is **inactive by default** — apply + get TikTok approval, select the Customer Service category; criteria ≈ **1000+ authorized sellers OR ~1M API calls/day**, and you must **already ship a live in-app chat UI** (mock not accepted); self-developed sellers may get special approval. (2) Per-buyer reachability: conversation in last 30d **OR** order in 60d **OR** return/refund history (returns satisfy this). `can_send_message` is the runtime per-conversation gate.
- **Linkage:** Create Conversation takes **`buyer_user_id` only** (no `order_id`/`return_id`) — a per-return chat panel links only indirectly (via buyer/order). You can post a `RETURN_REFUND_CARD{order_id,sku_id}` into a thread.
- Message types: `TEXT`(≤2000), `IMAGE`, `VIDEO`, `PRODUCT_CARD`, `ORDER_CARD`, `RETURN_REFUND_CARD`, `COUPON_CARD`, `LOGISTICS_CARD`. CS image upload: JPG/GIF/WebP/PNG, ≤10MB.

---

## 7. SLA & status buckets
- **Deadline field:** `seller_next_action_response[].deadline` (unix) — ground truth. Auto-approve default **48h** (policy prose, not in schema); ~4 business days to inspect returned goods; **2026-01-26 policy** shortens refund-only responses to **1 working day** in enforcement cases. Use the field; fall back to 48h assumption if absent.
- **Buckets:**
  - **Needs seller response:** `seller_next_action_response[]` present · `RETURN_OR_REFUND_REQUEST_PENDING` · `REPLACEMENT_REQUEST_PENDING`
  - **Waiting for buyer return:** `AWAITING_BUYER_SHIP` · `BUYER_SHIPPED_ITEM` · `AWAITING_BUYER_RESPONSE`
  - **Waiting for TikTok review:** `arbitration_status = IN_PROGRESS`
  - **Refund issued / success:** `RETURN_OR_REFUND_REQUEST_SUCCESS` · `_COMPLETE` · `REPLACEMENT_REQUEST_REFUND_SUCCESS` · `REPLACEMENT_REQUEST_COMPLETE`
  - **Rejected:** `REFUND_OR_RETURN_REQUEST_REJECT` · `REJECT_RECEIVE_PACKAGE` · `REPLACEMENT_REQUEST_REJECT`
  - **Closed/cancelled:** `RETURN_OR_REFUND_REQUEST_CANCEL` · `REPLACEMENT_REQUEST_CANCEL` · `arbitration_status = CLOSED`
  - **Arbitration ruling:** `SUPPORT_BUYER` / `SUPPORT_SELLER`

---

## 8. UI feasibility labels
| UI element | Label |
|---|---|
| Return/refund list | ✅ API-supported |
| Detail drawer/page | ✅ API-supported (2 reads) |
| Customer reason & message | ✅ API-supported (reason on object; message via records note) |
| Customer evidence images/videos | ✅ API-supported *(needs valid token/prod probe to confirm URL rendering; proxy backend)* |
| Timeline/history | ✅ API-supported (activity-log grade; `event` not enumerated) |
| Suggested response templates | ✅ API-supported (our own data; no TikTok dependency) |
| Seller comment box | ⚠️ API-supported **only within a reject**; standalone = **Not supported by API** (copy/Seller Center) |
| Seller image upload | ⚠️ Images only, on reject, via Product Image Upload; broader evidence = **Seller Center only** |
| Message buyer button | 🔒 Requires TikTok approval (CS API) → else **copy-to-clipboard** + Seller Center deep-link |
| Copy-to-clipboard fallback | ✅ Always available |
| Seller Center deep-link fallback | ✅ Always available |
| Approve/reject/refund w/ proper reason codes | ✅ API-supported (writes; use `reject_reasons` + `decision` enums) |

---

## 9. Recommended product design (given the limits)
- **Detail view = Search Returns (header) + Get Return Records (timeline/evidence).** Render status/type/refund/tracking/SLA up top; a chronological, role-tagged feed below with buyer note + evidence gallery.
- **Proxy all evidence media** through our backend and re-fetch on view (URLs may expire) — don't hotlink/persist.
- **Actions:** approve/reject/partial/return-less/replacement→refund as first-class buttons, pre-gated by `aftersale_eligibility`, reason dropdown from `reject_reasons`, `idempotency_key` per action.
- **Seller→buyer free-form communication:** default to **copy-to-clipboard templates + "Open in Seller Center"**; treat live CS chat as a later, approval-gated upgrade.
- **Dispute/appeal & extra evidence:** **deep-link to Seller Center** (no API).

### What goes where
- **API-powered:** list, detail, reason, buyer message text, evidence viewing, timeline, status/SLA buckets, approve/reject/refund/partial/return-less/replacement decisions, reject reason codes, refund preview.
- **Copy-to-clipboard:** all proactive seller→buyer messaging (until CS approved), "request more info," any free-form note beyond a reject comment.
- **Seller Center deep-link:** upload dispute evidence (video/docs), respond to/appeal arbitration, request buyer info, anything under `arbitration_status`.

*Audit only — nothing implemented.*
