# Backlog

Deferred items captured during build passes. Not scheduled — pulled into a phase when prioritized.

## Proper shop-logo source (Shop API)

**Status:** deferred (noted 2026-07-02, UI cleanup pass 1).

**Context:** `tiktok_connections.shop_logo` is currently written only in `src/app/api/tiktok/sync/route.ts`, sourced from the **GMV Max / Business (ads) API** store list (`gmv_max/store/list`). That advertiser can represent a *different brand* than the TikTok Shop a login actually operates (e.g. a `lotsofsteals` login whose only business connection belongs to the `Snore` advertiser). Pass-1 shipped **Option A**: only adopt a logo from an advertiser store that matches this connection (by shop name or cipher/id); on no match, clear it (UI falls back to the neutral TikTok glyph — never the wrong brand).

**Option B (proper fix):** source the logo from the **TikTok Shop API** — the shop's own brand icon — instead of the ads advertiser. This is a real feature: needs a Shop API endpoint to fetch shop profile/brand assets, wired into the connect/sync flow, and testing. Once in place it supersedes the ads-API logo path (Option A's match-or-clear becomes a fallback or is removed).

**Acceptance:** every connected shop shows its own brand logo, keyed to the active shop, with no cross-brand contamination and no dependency on the ads advertiser.
