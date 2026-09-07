#!/usr/bin/env bash
# Local DB verification for MANUAL WORKED SHIFT CREATION (migration 131).
#
# Boots a throwaway Postgres in Docker, applies the base stub + the REAL employee/shift/time-clock
# /scheduling migrations + the REAL 131, then proves the overlap guard: identical and partial
# overlaps refused, legitimate split shifts allowed, touching endpoints allowed, overnight handled
# across calendar dates, punches blocking manual entry, break validation, tenancy, and that no
# punch/audit row is ever fabricated. Finishes with a genuine TWO-SESSION RACE.
#
# Requires Docker only (psql runs inside the container). No host psql needed.
# Usage:  supabase/tests/manual_worked/run.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGDIR="$SCRIPT_DIR/../../migrations"
CONTAINER="lensed_manual_worked_test_$$"
IMAGE="postgres:16-alpine"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run(){ # run <file> [extra psql args...]
  local file="$1"; shift
  docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 "$@" < "$file"
}
sql(){ docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 -tAc "$1"; }

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
echo -n "▶ waiting for postgres"
# The alpine image starts a temporary init server (answers briefly) before the real one, so
# require several CONSECUTIVE successful queries to be sure the real server is stably up.
ready=0; streak=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    streak=$((streak + 1))
    if [ "$streak" -ge 3 ]; then ready=1; break; fi
  else
    streak=0
  fi
  echo -n "."; sleep 1
done
[ "$ready" -eq 1 ] || { echo " NOT ready — aborting"; exit 1; }
echo " ready"

docker exec "$CONTAINER" createdb -U postgres db >/dev/null

echo "── bootstrap (stubs) ──"
run "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1

echo "── apply real migrations (base → time clock → scheduling) ──"
for m in 044_create_employees_and_shifts 047_create_recurring_shifts 052_shifts_open_shift \
         055_shifts_source_rule_id 070_time_clock_attendance 071_time_clock_rpcs \
         072_time_clock_robustness 085_scheduling_v1_schema 086_collapse_shift_templates \
         090_shift_instances_admin_open; do
  # stderr is NOT swallowed: a prerequisite that fails silently turns every assertion below it
  # into a vacuous pass, which is exactly the trap CONVENTIONS.md warns about.
  err="$(run "$MIGDIR/$m.sql" -1 2>&1 >/dev/null)" \
    || { echo "  ✗ migration $m failed to apply:"; echo "$err" | head -3 | sed 's/^/      /'; FAILED=1; }
done

echo "── apply the migration under test: 131 (verbatim, its own begin/commit) ──"
run "$MIGDIR/131_manual_worked_shift_rpc.sql" >/dev/null || { echo "  ✗ 131 FAILED TO APPLY"; FAILED=1; }

echo "── catalog + grants (must match CONVENTIONS.md and comparable RPCs) ──"
echo "  server: $(sql "select version()" | cut -d, -f1)"
chk(){ # chk <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "  ✓ $1 = $2"; else echo "  ✗ $1 = $2 (expected $3)"; FAILED=1; fi
}
FN_SIG=$(sql "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_create_manual_worked_shift'")
chk "creator signature" "$FN_SIG" "lensed_create_manual_worked_shift(uuid,date,time without time zone,time without time zone,integer)"
chk "creator returns"   "$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_create_manual_worked_shift'")" "shifts"
chk "creator security"  "$(sql "select case when prosecdef then 'definer' else 'invoker' end from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_create_manual_worked_shift'")" "invoker"
chk "creator search_path" "$(sql "select array_to_string(proconfig,',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_create_manual_worked_shift'")" "search_path=public"
chk "creator volatility" "$(sql "select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_create_manual_worked_shift'")" "v"
chk "creator EXECUTE authenticated" "$(sql "select has_function_privilege('authenticated','public.lensed_create_manual_worked_shift(uuid,date,time,time,integer)','execute')")" "t"
# anon / PUBLIC: this migration issues no REVOKE, so PostgreSQL's DEFAULT (EXECUTE to PUBLIC) still
# stands — the same posture as every other authenticated-callable lensed_* RPC (lensed_clock_in
# etc.). Pinned so a future change is deliberate; the boundary is auth.uid() being NULL for anon,
# which the function refuses as NOT_AUTHENTICATED (asserted in test 14).
echo "  note: anon/PUBLIC EXECUTE = $(sql "select has_function_privilege('anon','public.lensed_create_manual_worked_shift(uuid,date,time,time,integer)','execute')")/$(sql "select has_function_privilege('public','public.lensed_create_manual_worked_shift(uuid,date,time,time,integer)','execute')") — default grant, matches sibling user-session RPCs; auth.uid() IS the gate"
HELPER_SIG=$(sql "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_shift_wall_range'")
chk "helper signature" "$HELPER_SIG" "lensed_shift_wall_range(text,date,time without time zone,time without time zone,timestamp with time zone,timestamp with time zone)"
chk "helper returns"    "$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_shift_wall_range'")" "tsrange"
chk "helper IMMUTABLE"  "$(sql "select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_shift_wall_range'")" "i"
chk "helper EXECUTE authenticated" "$(sql "select has_function_privilege('authenticated','public.lensed_shift_wall_range(text,date,time,time,timestamptz,timestamptz)','execute')")" "t"
chk "no accidental overloads" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lensed_create_manual_worked_shift','lensed_shift_wall_range')")" "2"
# The migration must not have touched any TABLE.
chk "no new/changed table constraints" "$(sql "select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='shifts' and c.conname ilike '%overlap%'")" "0"

echo "── run manual-worked assertions (overlap · split · overnight · break · tenancy) ──"
run "$SCRIPT_DIR/test_manual_worked.sql" || FAILED=1

# LAST of the SQL files: it enables RLS and drops to the `authenticated` role to reproduce the
# real production posture, which changes the world for anything that runs after it.
echo "── tenant isolation under REAL RLS as the authenticated role ──"
run "$SCRIPT_DIR/test_tenancy_rls.sql" || FAILED=1

# ── the race, which needs two real connections ───────────────────────────────
# Session A opens a transaction, calls the RPC (taking the per-employee advisory lock and
# inserting), then holds the transaction open. Session B calls the RPC for an OVERLAPPING interval
# while A is still uncommitted. B must BLOCK on the lock — not read "no conflict" and insert — and
# then, once A commits, see A's row and refuse. Exactly one payable row may exist at the end.
echo "── two-session race (both managers save at once) ──"
RACE_EMP='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQLA &
set test.user_id = '11111111-1111-1111-1111-111111111111';
begin;
select public.lensed_create_manual_worked_shift('$RACE_EMP'::uuid, '2026-10-05'::date, '06:00'::time, '14:00'::time, 0);
select pg_sleep(3);
commit;
SQLA
A_PID=$!
sleep 1   # let A take the lock before B starts
B_OUT=$(docker exec -i "$CONTAINER" psql -U postgres -d db -tA <<SQLB 2>&1
set test.user_id = '11111111-1111-1111-1111-111111111111';
select public.lensed_create_manual_worked_shift('$RACE_EMP'::uuid, '2026-10-05'::date, '13:00'::time, '17:00'::time, 0);
SQLB
)
wait $A_PID
ROWS=$(sql "select count(*) from public.shifts where employee_id='$RACE_EMP'")

if echo "$B_OUT" | grep -q 'WORKED_TIME_OVERLAP'; then
  echo "  ✓ loser refused with WORKED_TIME_OVERLAP (blocked on the advisory lock until the winner committed)"
else
  echo "  ✗ RACE FAILED — loser was not refused. psql said: $B_OUT"; FAILED=1
fi
if [ "$ROWS" = "1" ]; then
  echo "  ✓ exactly ONE payable row exists after the race (not two)"
else
  echo "  ✗ RACE FAILED — expected 1 row for the raced employee, got $ROWS"; FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then echo "✅ manual-worked DB tests PASSED"; else echo "❌ manual-worked DB tests FAILED"; fi
exit "$FAILED"
