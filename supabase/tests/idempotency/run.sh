#!/usr/bin/env bash
# Local verification for migration 043 (live-order idempotency).
# Boots a throwaway Postgres in Docker, applies the base schema + migration, and runs
# both the "bug fixed" and "normal flows intact" assertions, plus the repair + abort
# cases. Requires Docker. No host psql needed (runs psql inside the container).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$SCRIPT_DIR/../../migrations/043_live_order_idempotency.sql"
CONTAINER="lensed_idem_test_$$"
IMAGE="postgres:16-alpine"
ERRLOG="$(mktemp)"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -f "$ERRLOG"; }
trap cleanup EXIT

run(){ # run <db> <file> [extra psql args...]
  local db="$1" file="$2"; shift 2
  docker exec -i "$CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@" < "$file"
}

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
echo -n "▶ waiting for postgres"
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  echo -n "."; sleep 1
done
echo " ready"

# ── DB 1: conservative repair (unambiguous) + forward-behavior tests ──
docker exec "$CONTAINER" createdb -U postgres db_main >/dev/null
echo "── db_main: bootstrap + seed pre-fix duplicate ──"
run db_main "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1
run db_main "$SCRIPT_DIR/seed_main.sql" >/dev/null || FAILED=1
echo "── db_main: apply migration 043 (single transaction) ──"
run db_main "$MIG" -1 || FAILED=1
echo "── db_main: assert repair ──"
run db_main "$SCRIPT_DIR/assert_repair.sql" || FAILED=1
echo "── db_main: forward-behavior tests (bug fixed + normal flows intact) ──"
run db_main "$SCRIPT_DIR/test_forward.sql" || FAILED=1
echo "── db_main: multi-live isolation tests (separate lives not merged) ──"
run db_main "$SCRIPT_DIR/test_multi_live.sql" || FAILED=1

# ── DB 2: abort-on-ambiguity (must change nothing) ──
docker exec "$CONTAINER" createdb -U postgres db_abort >/dev/null
echo "── db_abort: bootstrap + seed ambiguous duplicate ──"
run db_abort "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1
run db_abort "$SCRIPT_DIR/seed_abort.sql" >/dev/null || FAILED=1
echo "── db_abort: apply migration 043 (expect DEDUP_NEEDS_MANUAL_REVIEW) ──"
if run db_abort "$MIG" -1 2>"$ERRLOG"; then
  echo "  ✗ migration unexpectedly SUCCEEDED on ambiguous data"; FAILED=1
elif grep -q "DEDUP_NEEDS_MANUAL_REVIEW" "$ERRLOG"; then
  echo "  ✓ aborted with DEDUP_NEEDS_MANUAL_REVIEW"
else
  echo "  ✗ aborted, but not with DEDUP_NEEDS_MANUAL_REVIEW:"; cat "$ERRLOG"; FAILED=1
fi
echo "── db_abort: assert nothing changed ──"
run db_abort "$SCRIPT_DIR/assert_abort.sql" || FAILED=1

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ ALL IDEMPOTENCY TESTS PASSED"; else echo "❌ SOME TESTS FAILED"; fi
exit "$FAILED"
