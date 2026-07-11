# Lensed — Tech Stack & Structure

## Web app stack
- **Next.js 16** (App Router) + **React 19** + **TypeScript** (strict)
- **Tailwind CSS 4** (PostCSS)
- **TanStack React Query 5** for all server data fetching/caching
- **Chart.js 4** + react-chartjs-2 for dashboard charts
- **LiveKit** (client + server SDK) for WebRTC video in the training simulator
- **Supabase** — Postgres, Auth (email/password + Google OAuth), RLS, Realtime
- Deployed on **Vercel** (`vercel.json`, security headers in `next.config.ts`)

## iOS app stack
- **SwiftUI** + **WidgetKit** (home-screen metrics), MVVM
- Shares the **same Supabase backend**; supports **TikTok Shop + Whatnot**

## Integrations
- **TikTok Shop API** (OAuth 2.0, HMAC-signed) — orders, finance, products, returns, video stats
- **TikTok Business API** (optional) — ad spend
- **LiveKit Server SDK** — token generation for training video

## Repo layout (top level)
```
src/                  # Next.js web app (main codebase)
supabase/migrations/  # 35+ SQL migration files
Lensed/               # iOS SwiftUI app
LensedWidgets/        # iOS home-screen widgets
Lensed.xcodeproj/     # Xcode project
extension/            # Chrome extension (stub)
public/ , logos/      # static assets
```

## Web app internals (`src/`)
```
app/
  (app)/        # auth-gated routes: dashboard, entries, products, live/[id], plans, account, admin/*
  (auth)/       # login, signup
  api/          # API routes (tiktok/*, live/*, inventory/*, shipping/*, training/*)
  page.tsx      # landing page
components/      # dashboard, entries, products, live, training, tiktok, inventory, shipping, ...
hooks/          # React Query hooks (useEntries, useLiveSessions, useProducts, useTikTok, ...)
lib/
  supabase/     # client, server, admin, middleware helpers
  tiktok/       # TikTok Shop + Business API clients
  training/     # LiveKit channel/video utils
  calculations.ts  # P&L math (margin, COGS, ROI)
  crypto.ts     # encrypt/decrypt OAuth tokens
  csv.ts , env.ts , chart-options.ts
types/index.ts   # shared TS interfaces
middleware.ts    # Supabase session refresh
```

## Key routes
- `/dashboard` — GMV, net profit, margin, ROAS, product breakdown
- `/entries` — daily P&L logs; bulk CSV import
- `/products` — products, variants, per-unit costs (COGS)
- `/live/[id]` — live auction session detail
- `/plans`, `/account`, `/login`, `/signup`, `/privacy`
- **Admin only** (`app_metadata.role === 'admin'`):
  - `/admin/training/practice-mode`
  - `/admin/training/live-simulator` (+ `/control` trainer controller)

## Commands
```bash
npm run dev     # dev server at http://localhost:3000
npm run build   # production build
npm run start   # run built app
npm run lint    # ESLint
```
