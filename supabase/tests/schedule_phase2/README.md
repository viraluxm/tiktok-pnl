# Schedule Phase 2 — migration 129 DB harness

Executable verification for `supabase/migrations/129_schedule_phase2_offer_lifecycle.sql`
(the offer lifecycle behind Drop Shift / Pick Up Shift / manager approval).

This database has **no migration ledger** — migrations are applied by hand and the repo file is
the only record. That makes "does this file actually execute, and does it do what its comments
claim?" a question worth answering *before* it reaches production, not after.

## Prerequisites

* **Docker only.** `psql` runs inside the container; no host Postgres client is needed.
* The `postgres:16-alpine` image (pulled automatically on first run).

Any Docker-compatible runtime works — Docker Desktop, OrbStack, colima, podman with a `docker`
shim. The daemon must be running.

## Usage

```bash
supabase/tests/schedule_phase2/run.sh
```

Exit code `0` = everything passed, `1` = something failed. The container is destroyed on exit,
including on failure or Ctrl-C (`trap cleanup EXIT`).

## Safety

The harness **only ever talks to a disposable local container**. It takes no host, URL, database
name or credential input; it does not read `.env*`; and it never contacts a hosted project. The
container name is suffixed with the shell PID, so concurrent runs cannot collide.

## What it does

1. Boots a throwaway Postgres 16 and creates an empty database.
2. Applies `bootstrap.sql` — the minimal stub the real migrations assume exists (`auth.users`,
   `auth.uid()`, `set_updated_at()`, and the `anon` / `authenticated` / `service_role` roles).
3. Applies the **real repo migrations** that build the target tables — `044`, `047`, `085`,
   `086`, `090` — so the pre-129 world is the genuine one, not a hand-written approximation.
4. Applies the **real `129` file, verbatim**, with no `-1` wrapper, so the file's own
   `begin; … commit;` is what's exercised. Nothing is copied or inlined; edit the migration and
   this harness tests the edit.
5. Diffs the catalog before/after and fails on anything dropped or narrowed. The single permitted
   replacement is `shift_claims_status_check`, which is widened to a strict superset.
6. Runs the assertion files, then the checks that need real sessions.

## Files

| File | Covers |
|---|---|
| `bootstrap.sql` | minimal base world (stubs only) |
| `harness.sql` | assertion helpers + fixture builders |
| `seed.sql` | two owners, five employees (one `former`, one foreign-tenant) |
| `catalog.sql` | stable, diffable projection of everything 129 touches |
| `test_constraints.sql` | `shift_instances` offer CHECKs — the four accepted row shapes and every rejected one |
| `test_claims.sql` | `shift_claims` CHECKs + both partial UNIQUE indexes; legacy OT flow untouched |
| `test_rpc.sql` | happy-path transfer, replay, and every refusal path |
| `test_atomicity.sql` | torn-state regression (see below) |
| `run.sh` | orchestration + grants, concurrency, out-of-transaction rollback, idempotence |

## The regression this exists for

An earlier draft of 129 returned a refusal `jsonb` from **every** failure path — including the
ones *after* the assignment `UPDATE` had already run. `return` rolls nothing back, so the caller
was told "refused" while the transfer stayed committed: the shift moved to a new owner with no
approved claim behind it, and the CAS pre-state was consumed so it could never be re-approved.

The fix was to make every post-assignment failure `raise`. `test_atomicity.sql` reaches that path
for real (by colliding the winner `UPDATE` with `idx_shift_claims_one_approved_pickup`) and
asserts the whole transfer disappears. `run.sh` then repeats it in the true PostgREST shape — an
autocommit call whose error aborts the implicit transaction, re-read from a fresh connection.

## Assertion style

`t_reject` takes the name of the rule that must fire. Asserting only "this failed" is nearly
worthless for a constraint suite: a row can be rejected by the *wrong* constraint, or by a typo'd
column name, and a weaker test would still pass.

## Known documented behaviour (not a failure)

`idx_shift_claims_one_pending_pickup_per_employee` is keyed on the **shift**, not the offer cycle,
so it also blocks a request under a new cycle while an old-cycle request is still pending. That is
unreachable today — nothing re-offers a shift with pending requests left behind — but it becomes
reachable the moment **Cancel Offer** ships, which must supersede the previous cycle's pending
requests. `test_claims.sql` pins the current behaviour so the change is deliberate when it happens.
