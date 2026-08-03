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
