# Approved hours — migration 139 DB harness

Executable verification for `supabase/migrations/139_shift_approved_minutes.sql`: the
`shifts.approved_minutes` column, the widened confirmation guard, and the three RPCs that are the
only way an approved duration can be written.

Same shape as `../timeclock` and `../schedule_phase2`: a THROWAWAY Postgres 16 in Docker, the REAL
repo migrations that build `shifts` + the time clock (044/047/052/055/070/071/072), then the REAL
139 file verbatim, then the assertions. It never contacts a hosted database and reads no `.env*`.

```bash
supabase/tests/approved_hours/run.sh
```

| File | Covers |
|---|---|
| `test_approved.sql` | the column + CHECK, the guard (direct writes refused), confirm with/without approved minutes, the LIVE HOST requirement, unconfirm clearing the approval, the payroll-only correction RPC, and that no RPC ever moves a punch |
| `run.sh` | orchestration + the one-arg overload really being gone + grants + idempotence |

The employee-facing half of the same rule (payroll reads approved minutes; legacy rows keep their
old figure) is asserted in `src/lib/employees.approvedHours.test.mjs`.
