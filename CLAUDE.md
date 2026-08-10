# Lensed

Next.js (App Router) + Supabase/Postgres SaaS for a warehouse-based TikTok
live-selling operation: inventory, live-auction capture, order sync, pick/pack
fulfillment, employee timekeeping, and scheduling. The `extension/` directory is
a separate Chrome capture extension.

## Working agreement

- **Investigate read-only first.** Before writing anything, report findings with
  file paths and line numbers and wait for approval.
- **Confirmed vs inferred.** Distinguish what you actually grepped/read from what
  you inferred. Never present inference as fact.
- **One change at a time.** One deploy per unit of work. Never bundle unrelated
  changes into the same migration, PR, or commit.
- **Dry-run before production.** Any job that writes production data ships behind
  a flag, log-only first, and is dry-run with output shown before a real run.
- **Explicit approval gates.** Merges and deploys require explicit approval — do
  not merge or deploy on your own initiative.
- **Use `git worktree`** rather than checking out branches in the shared working
  tree — another session may be active in it. Keep branches short-lived; long-
  lived branches diverging from a moving base accumulate reconciliation cost that
  has already forced work to be abandoned here.

## Migrations — no ledger

This DB has **no migration ledger**. Migrations are **applied by hand**; the repo
file under `supabase/migrations/` is the *only* record of what has run. Assume DB
state is **unverified** against the repo — inspect the live schema before writing
or applying a migration. Prefix collisions and gaps exist and are real skip/
double-apply hazards, not cosmetic. Number a new migration above the highest
claimed prefix (check tracked files, untracked working-tree files, and branches);
do not backfill gaps. Claude writes migration files but does **not** apply them —
the user applies by hand, gated on write-activity silence (below).

## Write-activity silence gate

Gate covered writes on **write-activity silence** — **not** on `live_sessions.status
= 'live'`. That flag is unreliable and must not be used as a safety interlock.

Silence = both of these more than ~15 minutes stale, **checked and reported before
the first write**:
- the latest `capture_events` write, and
- `live_sessions.last_seen_at`.

**What the gate covers:** schema migrations, and any write (insert/update/delete/
backfill/seed) to a table **in the capture or order-sync path** — the tables read or
written during a live show. Weekends are not automatically quiet — shows run on Sundays.

**Exempt (NOT gated):** the scheduling tables — `shift_rules`, `shift_instances`,
`shift_claims`, `employee_access_tokens`, `attendance_events`. Nothing reads them during
a live show; their rows carry future dates; a transactional swap is consistent for any
concurrent reader. Writes here may proceed regardless of show activity (still report the
check result for the record).

Any table **not** on the exempt list stays gated. **Adding a table to the exempt list
requires the user's explicit approval** — do not extend it on your own judgment.

## The `extension/` directory

Do **not** modify `extension/` unless the task is explicitly about the capture
extension. It is a separate deploy surface with its own auth/session handling.

## Auth sessions and the capture JWT

The capture extension holds a Supabase JWT and writes `capture_events` directly
to PostgREST under its own `user_id`, protected by own-row RLS. Anything that
establishes a *different* Supabase session on a host machine will replace that
JWT via `onMessageExternal`, and captures will silently write under the wrong
`user_id` — invisible to the real owner, with no error.

Consequences, all non-negotiable:

- Sub-user accounts (station, VA) must **never** sign into lensed.io on a host
  machine.
- Public/tokenized routes must **never** establish a Supabase auth session: no
  `signIn`, no session cookie, no client-side auth client. Use the service-role
  client server-side only, scoped explicitly by the identity resolved from the
  token, with every filter written into the query rather than relying on RLS.
- The extension must never refresh its auth token independently of the web app.
  Refresh-token rotation races cause random logouts. The extension is a passive
  follower of a single refresher.

## Business constants

- Single timezone: `America/Los_Angeles` (server-fixed constant in app code, not a
  DB column).
- Biweekly pay period, anchored at `PAY_ANCHOR` in `src/lib/employees.ts`. Pay is
  derived (hours × rate), never stored. `isPayableShift()` is the payroll read
  gate — treat it as load-bearing.
