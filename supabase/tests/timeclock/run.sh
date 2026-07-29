#!/usr/bin/env bash
# Local DB verification for the employee time clock (migrations 070 + 071).
# Boots a throwaway Postgres in Docker, applies the base stub + the REAL employee/shift
# migrations + 070/071, then runs the attendance/shift assertions. Requires Docker only
# (psql runs inside the container). No host psql needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGDIR="$SCRIPT_DIR/../../migrations"
CONTAINER="lensed_timeclock_test_$$"
IMAGE="postgres:16-alpine"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run(){ # run <file> [extra psql args...]
  local file="$1"; shift
  docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 "$@" < "$file"
}

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
echo "── apply real migrations 044, 047, 052, 055, 070, 071 ──"
for m in 044_create_employees_and_shifts 047_create_recurring_shifts 052_shifts_open_shift \
         055_shifts_source_rule_id 070_time_clock_attendance 071_time_clock_rpcs; do
  run "$MIGDIR/$m.sql" -1 >/dev/null || { echo "  ✗ migration $m failed to apply"; FAILED=1; }
done
echo "── run time-clock assertions (owner; RPC + guard + overnight + confirm) ──"
run "$SCRIPT_DIR/test_timeclock.sql" || FAILED=1
echo "── run RLS isolation assertions (two authenticated identities) ──"
run "$SCRIPT_DIR/test_rls.sql" || FAILED=1

if [ "$FAILED" -eq 0 ]; then echo "✅ time-clock DB tests PASSED"; else echo "❌ time-clock DB tests FAILED"; fi
exit "$FAILED"
