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
- **Never run a state-mutating git command inside a diagnostic.** Investigating is
  read-only: `log`, `show`, `diff`, `status`, `fsck`, `merge-tree`, `cat-file`. A
  check that answers a question must not also change state. Two failures in one
  session, same error class: `git stash -u` + `git checkout <sha> -- .` inside a
  loop "verifying each commit typechecks in isolation" destroyed the uncommitted
  work in 23 tracked files; `git reset` inside a check for whether a test failure
  pre-dated the merge silently cleared `MERGE_HEAD`, turning the merge commit into
  a single-parent commit. If a diagnostic genuinely needs a mutable tree, use a
  throwaway `git worktree` or `git commit-tree`/`--no-index` against blobs — never
  the tree you are working in.
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
do not backfill gaps. Claude writes the migration file; who **applies** it depends on its
lock footprint — Class A vs Class B below.

### `create or replace`: rebuild from live `prosrc`, never hand-copy

A `create or replace function` ships the **entire** body. Hand-copying it to change
a few lines silently risks dropping or rewording any other line — a drifted line
changes live behavior with nothing to catch it. **Rule:** author a create-or-replace
by pulling the current body from the live DB (`select prosrc from pg_proc …`), apply
**only** the intended edit, and **diff the new body against live `prosrc` before
applying** — the diff must show *only* the intended change (comments included). Never
reconstruct the body from memory or an older migration file. (This caught real comment
drift in the 097 kiosk-instants fix.)

## Deploy/write gate — classify by LOCK FOOTPRINT, not by silence

**The operation is continuously live.** Shows run essentially every day, and there is no
longer a reliable ~15-minute quiet window. A gate that can never be satisfied does not get
followed carefully — it gets skipped by habit, including on the one change where it actually
mattered. So writes are gated on what they **lock**, not on whether a show is running.

`live_sessions.status = 'live'` remains unreliable and must **never** be used as an interlock.

**Always check and report before the first write** — as evidence for the record, no longer as
a veto:
- the latest `capture_events` write, and
- `live_sessions.last_seen_at`.

### Class A — may proceed during a live show

Additive changes using **NEW object names** that neither rewrite an existing table nor replace
a live function: `create table`, `create index concurrently`, new RPCs, and `add column` that
is **nullable with no default** (catalog-only in PG11+).

Required recipe, every time:
- each statement group in **its own transaction** with `set local lock_timeout = '3s'`, so a
  contended lock **aborts** the change instead of queueing in front of the capture path;
- md5 the `prosrc` of every function referencing the affected tables **before and after**, and
  confirm byte-identity;
- confirm `capture_events` kept landing across the window;
- report all of the above.

**"Additive" still touches live tables.** A foreign key takes `SHARE ROW EXCLUSIVE` on the
*referenced* table, and `inventory_skus` IS written mid-show by `lensed_log_auction` /
`lensed_log_auction_status_transition`. `lock_timeout` is what makes that safe — not the
absence of a show. Never skip it.

### Class B — still needs a genuine window and the user's explicit approval

- anything that **rewrites** a table (type changes, `set not null` on a populated column)
- dropping or altering a column on a capture / order-sync table
- `create or replace` or `drop` on a function the live path calls (see the `prosrc` rule above)
- **data** writes: backfills, seeds, bulk update/delete against capture or order-sync tables
- anything expected to hold `ACCESS EXCLUSIVE` on a hot table for more than an instant

For Class B the old silence rule still applies in spirit: get a real quiet window, or take the
interruption knowingly and say so first.

**Exempt from Class B data-write gating:** the scheduling tables — `shift_rules`,
`shift_instances`, `shift_claims`, `employee_access_tokens`, `attendance_events`. Nothing reads
them during a live show; their rows carry future dates; a transactional swap is consistent for
any concurrent reader. **Adding a table to this list requires the user's explicit approval** —
do not extend it on your own judgment.

### Who applies

Claude may apply **Class A** directly via the Management API, following the recipe above and
reporting before/after. **Class B is user-applied by hand.** Claude writes the migration file
either way — the repo file under `supabase/migrations/` remains the only record, since this DB
has no ledger.
### `shift_rules` is NOT a pay input — punches are the only one

**Superseded warning.** This section used to say that PayView projects active recurring rules
into pay at read time, so a rule created pay owed the moment it existed, double-paying against
any punch on the same day. **That was true before Deploy C and is no longer true.** It kept
producing a wrong double-pay warning long after the code changed, so it is corrected here.

Pay comes from real `shifts` rows only. Verified on `main`:

- `PayView.tsx` calls `computePay(employees, periodShifts)` — the recurring projection
  (`periodGenerated`) is computed but passed **only** to the display column, rendered as
  "Scheduled Xh · Paid Yh" so a gap is visible instead of silently paid.
- `isPayableShift()` in `src/lib/employees.ts` is the single choke point:

      if (isOpenShift(s)) return false;              // indeterminate hours
      if (s.source_rule_id != null) return false;    // materialized from a rule = plan, never pay
      if (s.source === 'time_clock' && s.confirmed_at == null) return false;

  That middle guard is what neutralises BOTH writers of rule-derived rows at once — the
  past-materializer cron and `freezeRulePast` on rule delete/deactivate. **Do not remove it**
  without moving the guarantee somewhere else; it is the whole reason a rule cannot pay anyone.

So creating, activating or editing a `shift_rule` does **not** create pay owed. What it does
affect:

- **the schedule shown** — rule projections are most of what the calendar renders as
  "Scheduled", and what the `/s/[token]` clock gate validates a punch against;
- **history, retroactively** — projections are computed at read time from *active* rules, so
  deactivating a rule blanks the scheduled span on PAST days too, taking every clocked-vs-
  scheduled delta with it. Materialize the past into `shift_instances` first if that context
  matters.

(The Aug-2026 rule seed was deactivated under the old, then-correct understanding. Its removal
is not evidence that rules pay — under today's code they do not.)

### Deploy risk classes (the gate above is about DATABASE writes, not all deploys)

The lock-footprint gate above governs **database writes** — migrations and writes to
capture / order-sync-path tables. Vercel **deploys** are governed separately, by what the
change can reach:

- **Additive application code** (new routes/components/logic that nothing live reaches yet):
  **not gated.** Deploy, then smoke-test in prod, with a rollback ready (revert the merge
  commit, or promote the previous Vercel deployment).
- **Auth middleware, session handling, or the extension token path** (app-wide blast radius —
  a wrong `middleware.ts` matcher bounces users to `/login`; session changes can clobber the
  capture extension's JWT): the **diff must be reviewed by the user first.** Once reviewed and
  approved, these do **not** need a quiet window — the extension's capture path does
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
