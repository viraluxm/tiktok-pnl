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
- **`git log --all -- <path>` before declaring work unrecoverable.** A file whose
  uncommitted changes were lost is not lost if another session committed the same
  work on another branch. Check every ref — not just the current branch, not just
  the reflog and `git fsck` — before reconstructing anything. This is not
  hypothetical: `claim.ts` and `api/labor/route.ts` were both rebuilt from scratch
  here while the real work sat on `main`, and the reconstruction was the stale side.
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

### `create or replace`: rebuild from live `prosrc`, never hand-copy

A `create or replace function` ships the **entire** body. Hand-copying it to change
a few lines silently risks dropping or rewording any other line — a drifted line
changes live behavior with nothing to catch it. **Rule:** author a create-or-replace
by pulling the current body from the live DB (`select prosrc from pg_proc …`), apply
**only** the intended edit, and **diff the new body against live `prosrc` before
applying** — the diff must show *only* the intended change (comments included). Never
reconstruct the body from memory or an older migration file. (This caught real comment
drift in the 097 kiosk-instants fix.)

## Write-activity silence gate

Gate covered writes on **write-activity silence** — **not** on `live_sessions.status
= 'live'`. That flag is unreliable and must not be used as a safety interlock.

Silence = both of these more than ~15 minutes stale, **checked and reported before
the first write**:
- the latest `capture_events` write, and
- `live_sessions.last_seen_at`.

**What the gate covers — DATABASE writes only:**
- schema migrations, **especially any that modify a shared function or trigger** (those
  change behaviour for every concurrent reader/writer the instant they land), and
- any write (insert/update/delete/backfill/seed) to a table **in the capture or
  order-sync path** — the tables read or written during a live show.

**What the gate does NOT cover: web-only Vercel deploys.** The business runs live
essentially 24/7, so a genuine write-quiet window may never arrive; gating application
deploys on it made the gate unopenable in practice and simply blocked shipping. Deploys
are governed by the risk classes below (additive code ships freely; auth/session/extension
changes need a reviewed diff), **not** by write-activity silence. The capture path writes
to PostgREST directly and does not route through Next.js, so a Vercel deploy cannot
interrupt a show in progress. Still check and report the gate for any DB write in the
same unit of work.

Weekends are not automatically quiet — shows run on Sundays.

**Exempt (NOT gated):** the scheduling tables — `shift_rules`, `shift_instances`,
`shift_claims`, `employee_access_tokens`, `attendance_events`. Nothing reads them during
a live show; their rows carry future dates; a transactional swap is consistent for any
concurrent reader. Writes here may proceed regardless of show activity (still report the
check result for the record).

Any table **not** on the exempt list stays gated. **Adding a table to the exempt list
requires the user's explicit approval** — do not extend it on your own judgment.

### `shift_rules` is a PAYROLL surface, not only a scheduling one

`shift_rules` is on the exempt list above (no live-show reader), but **exempt from the
write-silence gate does NOT mean low-stakes — it moves money.** PayView projects **active**
recurring rules into pay at read time (`generateRecurringShifts` → `computePay` in
`src/lib/employees.ts` / `PayView.tsx`), so scheduled hours become **pay owed** the moment a
rule exists — independent of the past-materializer and of `SHIFT_MATERIALIZE_WRITE_ENABLED`.
A recurring day with no punch pays full scheduled hours (manual/recurring shifts have no
`confirmed_at` gate; the only no-show handling is a manual `shift_exceptions` `'skip'`), and
it does **not** dedup against time-clock punches (the suppression set keys on `source_rule_id`,
which punches lack) → double-pay where both exist. **Any write to `shift_rules`
(insert / activate / edit times/days) requires checking the pay path (PayView / computePay),
not just the scheduling path.** (This is why the Aug-2026 rule seed had to be deactivated.)

### Deploy risk classes (the silence gate is about DATA writes, not all deploys)

The write-silence gate above governs **database writes** — migrations and writes to
capture / order-sync-path tables. Vercel **deploys** are governed separately, by what the
change can reach:

- **Additive application code** (new routes/components/logic that nothing live reaches yet):
  **not gated.** Deploy, then smoke-test in prod, with a rollback ready (revert the merge
  commit, or promote the previous Vercel deployment).
- **Auth middleware, session handling, or the extension token path** (app-wide blast radius —
  a wrong `middleware.ts` matcher bounces users to `/login`; session changes can clobber the
  capture extension's JWT): the **diff must be reviewed by the user first.** Once reviewed and
  approved, these do **not** need a write-silence window — the extension's capture path does
  not route through Next.js, so a reviewed deploy is safe during a show. Smoke-test immediately
  after, rollback ready.

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

### Middleware VALIDATES, it does not refresh — and revocation is not instant there

`src/lib/supabase/middleware.ts` reads the access token from the cookie and verifies its
signature **locally** against a pinned JWKS (`src/lib/supabase/jwks.ts`, ES256). It does **not**
call `getUser()` and does **not** rotate tokens. It used to, and that made every edge invocation a
second refresher racing the browser's on a rotating refresh token — the loser gets
`400 refresh_token_already_used`, which auth-js treats as non-retryable, destroys the session, and
emits `SIGNED_OUT`, bouncing an operator to `/login` mid-shift.

Consequences, all load-bearing:

- **Revocation is not real-time at the middleware layer.** A locally-verified JWT is accepted until
  its own `exp`, so a revoked session — or an `app_metadata` **role/scope change** — takes effect
  for ROUTING only within `jwt_exp` (**3600s**). This is safe **only** because middleware gates no
  data: every API route re-checks `getUser()` over the network and RLS enforces `auth.uid()`.
  **Anyone building a middleware decision that needs real-time revocation must not rely on the
  claims.** Do the check in the route.
- **Never call `getSession()` or the no-arg `getClaims()` in middleware or any hot server path.**
  Both refresh when the token is within `EXPIRY_MARGIN_MS` (90s) of expiry, **regardless of
  `autoRefreshToken: false`** — that flag only governs the background ticker. Pass the token
  explicitly: `getClaims(token, { keys })`.
- **The app role is `claims.app_metadata.role`, never `claims.role`.** The latter is the POSTGRES
  role and is always `'authenticated'`. Reading it confines every user and locks the whole app out
  (fail-closed, so an outage rather than a breach). Guarded by `src/lib/supabase/claims.test.mjs`.
- **Any authed route must have a browser Supabase client mounted**, or nothing refreshes its
  session and it dies at `jwt_exp`. `/fulfillment` has no app chrome, so it mounts
  `StationSessionRefresher` purely for this. Adding a new bare authed route means adding one too.
- API routes (`src/lib/supabase/server.ts` → `getUser()`) are **still** server-side refreshers.
  Reducing that is deliberately deferred; measure before changing it.

## Business constants

- Single timezone: `America/Los_Angeles` (server-fixed constant in app code, not a
  DB column).
- Biweekly pay period, anchored at `PAY_ANCHOR` in `src/lib/employees.ts`. Pay is
  derived (hours × rate), never stored. `isPayableShift()` is the payroll read
  gate — treat it as load-bearing.
