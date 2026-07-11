# Lensed — Data Model & Nuances

## Supabase tables (core)
| Table | Purpose |
|-------|---------|
| `profiles` | User metadata (display name, avatar) |
| `products` | Product catalog; variants stored as JSONB; linked to `tiktok_product_id` |
| `product_costs` | Cost per unit/variant — drives COGS |
| `entries` | Daily P&L records (manual or TikTok-synced): gmv, units_sold, shipping, affiliate, ads, platform_fee, views, videos_posted |
| `live_sessions` | Live auction shows; status = draft / live / ended / reconciled |
| `live_auction_items` | Items in a session: quantity, current price, qty sold, winner_ids |
| `inventory_skus` | Physical inventory per SKU |
| `lensed_batch_pricing` | FIFO batch costs (unit_cost, units, cost_basis) |
| `tiktok_shop_credentials` | Encrypted OAuth tokens + seller/shop info |
| `shipment_verifications` | Fulfillment / pick-list verification |
| `order_payouts` | Settlement amounts + dates |

**RLS:** every table is row-level secured — users only see their own rows. Some inventory is shareable at the org level (migration `035b_shared_inventory_orgs`).

## Environment variables (`.env.local`)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server only
TIKTOK_SHOP_APP_KEY=
TIKTOK_SHOP_APP_SECRET=
ENCRYPTION_KEY=                   # 32-byte hex, encrypts OAuth tokens
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=          # wss://...
```

## Nuances & gotchas worth knowing
- **Route groups:** `(app)` = auth-gated, `(auth)` = public. Parentheses are Next.js route groups, not URL segments.
- **Admin gating:** done server-side by checking `user.app_metadata?.role === 'admin'`. Admin is granted via one-time SQL on the Supabase user — there is no roles table.
- **Token security:** TikTok OAuth tokens are encrypted (`lib/crypto.ts`) before being stored in Supabase; refresh tokens auto-renew on expiry. OAuth state is kept in an httpOnly cookie for CSRF protection.
- **FIFO pricing:** COGS for live auctions uses FIFO batch pricing via atomic Postgres RPC functions (see migrations ~025, ~034) so margins reflect real cost basis.
- **Realtime:** the live simulator and live boards rely on Supabase Realtime subscriptions plus LiveKit for video/audio.
- **Camera policy:** `next.config.ts` sets `Permissions-Policy: camera=(self)` so the training simulator can use the camera only on same-origin.
- **P&L math** lives in `lib/calculations.ts` (margin, COGS, ROI/ROAS) — the single source of truth for profit numbers; reuse it rather than recomputing.
- **CSV import/export** for entries goes through `lib/csv.ts`.
- **Two clients, one backend:** the iOS app and web app share Supabase, so schema/RLS changes affect both. iOS additionally models Whatnot, which the web app does not.

## Practice Mode / Live Simulator (recent focus area)
Admin-only host training tool. A host streams camera/audio (via LiveKit) into a mock auction; a trainer uses `/admin/training/live-simulator/control` to push fake comments and bids. Recent work has been on video preview, mirroring overlays onto trainer video, and guarding host media startup after component unmount.
