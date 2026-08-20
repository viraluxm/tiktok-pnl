# Migration conventions

## RPC grants — READ THIS before adding any function the app calls

Three "silent 500 on first use" incidents traced to a function that existed but couldn't be
executed by the caller. Postgres grants EXECUTE broadly by default, but functions that are
explicitly revoked, or recreated, or applied **straight through the Management API** (bypassing
PRs and CI) can end up without the grant the app needs — and the failure is invisible until a
user clicks the button.

### The rule

Any function the app calls from a **user session** (`createClient(...).rpc('fn', …)`) MUST be
followed, in the same migration, by an explicit grant:

```sql
grant execute on function public.fn(<arg types>) to authenticated;
```

A function called **only** via `createAdminClient()` (service role bypasses grants) must instead
be locked down, and registered so the CI check knows it's intentionally ungranted:

```sql
revoke execute on function public.fn(<arg types>) from public, anon, authenticated;
-- then add 'fn' to SERVICE_ROLE_ONLY in scripts/check-rpc-grants.mjs
```

Dynamic calls — `supabase.rpc(someVariable, …)` — must carry a comment next to the call listing
every function the expression can resolve to, so the check can verify them:

```ts
// rpc-grants: lensed_confirm_time_clock_shift, lensed_unconfirm_time_clock_shift
```

### What enforces it

`scripts/check-rpc-grants.mjs` (CI: `.github/workflows/rpc-grants.yml`, and `npm run
check:rpc-grants`) scans every `.rpc()` call in `src/` and asserts `authenticated` has EXECUTE on
each — reading grants from the **live database**, so it catches grants applied outside
migrations too. An unannotated dynamic `.rpc()` fails the check rather than slipping through.

**CI only runs on PRs.** If you apply a function via the Management API, apply its `GRANT` in the
same step — this document is the backstop for the path CI can't see. When in doubt, run
`npm run check:rpc-grants` against the target database before considering the change done.

---

## Verification: a `NOT EXISTS` assertion must also prove its lookup found rows

**An assertion that passes because it had nothing to check reads identically to one that passed on
merit.** This has bitten twice now — a 111 rehearsal check asserting "the return type exposes no
cost column" passed vacuously because the `information_schema` lookup behind it matched zero rows,
and a 106 conservation check that would have been meaningless if its sample had been empty.

So, for any check shaped like "nothing bad exists":

```sql
-- NOT THIS — passes whether or not the lookup found anything
select not exists (select 1 from x where bad) as passed;

-- THIS — the count makes a vacuous pass visible
select not exists (select 1 from x where bad) as passed,
       (select count(*) from x)               as rows_examined;
```

Rules:

1. Every negative assertion reports the **cardinality of the set it examined**, in the same row.
2. A pass with `rows_examined = 0` is **not a pass** — it is an inconclusive check, and must be
   reported that way rather than counted in a "n/n passed" total.
3. Prefer a **positive** assertion where one exists. `pg_get_function_result(oid) NOT ILIKE
   '%cost%'` cannot pass vacuously; a `NOT EXISTS` over `information_schema` can.
4. The same applies to comparisons: a parity check between two result sets must report
   `rows_actually_compared`, or "0 mismatches" may only mean "0 rows".
5. Where practical, **mutate and re-run** to prove the check can fail at all — the
   `sessionEnd.drift.test.mjs` guard was verified this way before being trusted.

This is a reporting convention, not just a SQL one: the same trap exists in any test that filters
before it asserts.
