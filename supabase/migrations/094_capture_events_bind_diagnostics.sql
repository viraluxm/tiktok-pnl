-- 094_capture_events_bind_diagnostics.sql
-- RENAMED FROM 076_capture_events_bind_diagnostics.sql (original prefix: 076) to resolve a
-- cross-branch prefix collision — a committed 076_product_stats_totals_rpc.sql on branch
-- feat/dashboard-store-scoping also claims prefix 076 and has precedence. Renumbered to 094,
-- the next prefix free across all branches and remotes (093 was already taken by
-- 093_token_health_alerts.sql).
--
-- ALREADY APPLIED TO LIVE on 2026-08-09 via the Supabase Management API; verified byte-for-byte
-- against live in this session (columns, indexes, ext_diag_events table + RLS all match). DO NOT
-- REPLAY — every object below already exists on live; this file records applied state, not
-- pending work. (The `if not exists` guards make a replay harmless, but it must not be relied on.)
--
-- ─────────────────────────── original header (verbatim) ───────────────────────────
-- Server-side bind diagnostics. PART A of the bind-diagnostics feature.
--
-- WHY: capture_events records the sale, but carries NO signal for whether the extension
-- bound it to an auction item or WHY a bind failed. The leading suspect for tonight is the
-- SILENT "auction closed with nothing staged" path, which today writes a capture with no
-- bind trace. These columns make bind outcome + reason visible per capture, and a companion
-- ext_diag_events sink receives the extension's diagnostic ring for richer post-hoc analysis.
--
-- ADDITIVE ONLY. All new columns are nullable with NO default and NO backfill, so this cannot
-- affect any existing read or write path. NO CHECK constraint yet — unknown reason/code values
-- from a future extension build must be RECORDABLE, not rejected (we tighten later once the
-- value vocabulary is proven in the wild).

-- ── capture_events: per-capture bind outcome ──────────────────────────────────────────────
alter table public.capture_events
  add column if not exists bind_status       text,        -- 'bound' | 'failed' | 'not_attempted'
  add column if not exists bind_reason        text,        -- 'ok' | 'no_staged' | 'rpc_error' | 'no_session'
                                                           -- | 'unauthenticated' | 'out_of_stock' | 'sku_not_found'
  add column if not exists bind_error_code    text,        -- raw diagClassifyErr code / PG errcode
  add column if not exists bind_attempted_at  timestamptz, -- when the bind RPC was attempted (null if not_attempted)
  add column if not exists ext_version        text;        -- extension manifest version that wrote the row

-- Partial index for the common analytic query: "show me the non-bound captures + reasons".
create index if not exists idx_capture_events_bind_status
  on public.capture_events (bind_status)
  where bind_status is not null and bind_status <> 'bound';

-- ── ext_diag_events: server sink for the extension diagnostic ring (PART B.3) ──────────────
-- Fire-and-forget target for the ~60s ring flush. session_id/room_id are TEXT (not uuid FKs)
-- on purpose: a diagnostics sink must never reject a row for a malformed/unknown id, and must
-- never couple to live_sessions lifecycle. No CHECK, no FK — recording only.
create table if not exists public.ext_diag_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,          -- authenticated caller (stamped server-side by the API route)
  session_id text,          -- extension currentSessionId if known (text: never fail on a bad id)
  room_id    text,          -- tiktok_live_id
  ts         timestamptz,   -- client event timestamp
  event      text,          -- ring entry type, e.g. 'bind.rpc_error'
  code       text,          -- diagClassifyErr / errcode
  payload    jsonb,         -- redacted meta (never tokens/PII — the ring is already redacted)
  created_at timestamptz not null default now()
);

create index if not exists idx_ext_diag_events_session_time on public.ext_diag_events (session_id, ts desc);
create index if not exists idx_ext_diag_events_event_time on public.ext_diag_events (event, ts desc);

-- Service-role writes only (the /api/ext/diag route uses the admin client, which bypasses RLS);
-- no public policies — mirrors tracking_correction_log (066) / channel_resolve_conflict_log (072).
alter table public.ext_diag_events enable row level security;
