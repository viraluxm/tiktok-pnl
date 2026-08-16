# Stage 1 — middleware validates the access token, it does not refresh

**Shipped:** commit `5095a199`, deployed to production **2026-08-16 19:55:06 UTC** (12:55 PT).
**Rollback target:** `9a9f3ad0` (the prior production main).
**Pre-deploy snapshot:** `2026-08-16_stage1_predeploy_snapshot.json` — 40 sessions (12 carrying
`user_agent = 'Vercel Edge Functions'`), 1,228 refresh tokens, **median 0.62 tokens/hour**.

## What changed and why

The middleware called `supabase.auth.getUser()`, which loads the session and — when the access
token is within `EXPIRY_MARGIN_MS` (90s) of expiry — POSTs `/auth/v1/token` to **rotate** it. Every
edge invocation was therefore a second token refresher racing the browser's own, on a rotating
refresh token with a 60s reuse interval. The loser gets `400 refresh_token_already_used`, which
auth-js classifies as non-retryable: it destroys the session and emits `SIGNED_OUT`, bouncing an
operator to `/login` mid-shift for no reason.

Evidence it was real, not theoretical: several browser-created sessions had their
`auth.sessions.user_agent` overwritten to `'Vercel Edge Functions'` — i.e. last refreshed by the
middleware.

Now the middleware reads the access token from the cookie and verifies its **signature** locally
against a pinned ES256 JWKS. Zero network I/O on the happy path; nothing is rotated.

## Deploy-day verification

| Check | Result |
|---|---|
| Unauthenticated `/dashboard`, `/fulfillment`, `/team/binding` | 307 → `/login` ✅ |
| Unauthenticated `/login`, `/` | 200, body renders (no 500) ✅ |
| Authenticated `/dashboard` (owner) | loads fully with data, unconfined ✅ |
| Authenticated `/fulfillment` | loads (device-mode picker) ✅ |
| Authenticated `/team/binding` | page loads ✅ |
| Owner's own APIs (`/api/stores`, `/api/admin/channels`, `/api/tiktok/status`) | 200 ✅ |
| `capture_events` write rate across the deploy | 7–9 per 10 min before and after, no discontinuity ✅ |
| **Station longevity test** | **PASSED** ✅ — see below |

### Station longevity test — PASSED

A device stayed signed in on `/fulfillment` past the access-token expiry window (`jwt_exp` = 3600s)
and a scan worked afterward.

This was the single most important post-deploy check, and it could not be replaced by static
analysis. `/fulfillment` mounts no Supabase browser client of its own — the `(station)` layout is
deliberately bare — so before Stage 1 the **middleware was the only thing refreshing a station
session**. Removing that refresher without adding another would have made the route fail roughly
hourly, by construction. `StationSessionRefresher` (mounted in `src/app/(station)/layout.tsx`)
adopts the existing cookie session to start auth-js's own refresh ticker; **this test confirms it
works in production.**

Anything added later under `(station)` — or any new bare authed route without app chrome — needs
the same treatment. See the note in `CLAUDE.md`.

### Known, NOT caused by Stage 1

Owner/admin can reach `/team/binding` but its `/api/member/*` routes 403, because
`requireMemberScope` rejects anything without `app_metadata.role === 'member'` while the
middleware comment claims owner/admin retain full `/team` access. Confirmed to be the route guard,
not the middleware: on the same page load the owner's own APIs returned 200. Pre-existing
inconsistency, tracked separately.

## Accepted tradeoff: revocation is not instant at this layer

A locally-verified JWT is accepted until its own `exp`, so a server-side revocation — or an
`app_metadata` role/scope change — takes up to `jwt_exp` (**3600s**) to affect **routing**. This is
safe only because the middleware gates no data: every API route re-checks `getUser()` over the
network and RLS enforces `auth.uid()`. Documented in `CLAUDE.md`; do not build a middleware
decision that needs real-time revocation.

## Outstanding — the +24h measurement

Due after **2026-08-17 19:55 UTC**. Report BOTH:

1. Whether any session's `user_agent` flipped to `'Vercel Edge Functions'` **after** the deploy
   timestamp.
2. **Per-session rotation rate, before vs after**, against the pre-deploy snapshot (median
   0.62/hour). **Rate is the primary signal** — serverless API routes may present a similar UA, so
   the UA check alone cannot discriminate.

Expect a sharp drop toward ~1/hour (one browser refresher per session). **If the rate does not drop
meaningfully, stop and report — Stage 2 does not proceed on an unverified Stage 1.**

Note that API routes (`src/lib/supabase/server.ts` → `getUser()`) remain server-side refreshers;
Stage 1 addressed only the middleware. Any residual rotation above the browser baseline is most
likely them, and quantifying it is the input to deciding whether a Stage 1b is worth doing.
