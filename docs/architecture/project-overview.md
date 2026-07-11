# Lensed (tiktok-pnl) — Project Overview

## What it is
**Lensed** is a full-stack SaaS that gives **TikTok Shop sellers** a real-time **Profit & Loss (P&L) dashboard** and a **live-auction training platform**. The repo is named `tiktok-pnl`; the product brand is **Lensed**.

Sellers connect their TikTok Shop account, and Lensed automatically syncs orders, finances, products, and returns to track GMV, costs (COGS), margins, ad spend, and net profit. It also supports live-auction selling (bids, inventory, payouts) and an admin-only "Practice Mode" simulator for training hosts.

## Who it's for
TikTok Shop sellers — especially those doing **live auction selling** — who need to know whether they're actually profitable across products, shows, and time periods. A companion iOS app (also "Lensed") surfaces key metrics, including home-screen widgets, and also supports Whatnot (another livestream auction platform).

## The three surfaces in this repo
1. **Web app (primary)** — Next.js app in `src/`. This is the main codebase.
2. **iOS app** — SwiftUI app in `Lensed/` + `LensedWidgets/` (`Lensed.xcodeproj`). Talks to the same Supabase backend.
3. **Chrome extension** — currently a stub (`extension/.placeholder`); relays the Supabase session to the web app.

## Core value / domain concepts
- **P&L / COGS / margin** — every sale's profitability = GMV minus product cost, shipping, affiliate fees, ads, and platform fees.
- **Entries** — daily P&L records, either manually entered or synced from TikTok Shop.
- **Live sessions** — live auction shows with auction items, bids, winners, and reconciled payouts.
- **Inventory / FIFO batches** — physical SKU inventory with FIFO batch pricing so COGS reflects the actual cost basis of units sold.
- **Practice Mode** — admin-gated live-auction simulator (camera + mock comments/bids) for training hosts.

## Status
Production-grade and under active development. ~117 TS/TSX files, 35+ Supabase migrations, TypeScript strict mode, RLS on every table, encrypted OAuth tokens, HMAC-signed TikTok API requests.
