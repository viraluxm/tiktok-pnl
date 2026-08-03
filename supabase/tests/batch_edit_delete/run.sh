#!/usr/bin/env bash
# Local verification for migration 083 (FIFO cost-layer edit + delete).
# Boots a throwaway Postgres in Docker, applies the base schema + migration 083, runs
# the behavioral assertions (test.sql), then a real two-session test proving an edit
# blocks on the SAME per-SKU advisory lock a live sale takes. Requires Docker; no host
# psql (runs psql inside the container). Mirrors ../idempotency/run.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$SCRIPT_DIR/../../migrations/083_fifo_batch_edit_delete.sql"
CONTAINER="lensed_batch_test_$$"
IMAGE="postgres:16-alpine"
DB="db_batch"
A="11111111-1111-1111-1111-111111111111"
ORG1="22222222-2222-2222-2222-222222222222"
SKU_LOCK="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
echo -n "▶ waiting for postgres"
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  echo -n "."; sleep 1
done
echo " ready"

docker exec "$CONTAINER" createdb -U postgres "$DB" >/dev/null

echo "── bootstrap base schema ──"
psqlf < "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1
echo "── apply migration 072 ──"
psqlf -1 < "$MIG" || FAILED=1
echo "── behavioral assertions (test.sql) ──"
psqlf < "$SCRIPT_DIR/test.sql" || FAILED=1

# ── two-session lock test: an edit must WAIT on a held per-SKU sale lock ─────────
echo "── concurrency: edit blocks on the live-sale SKU lock ──"
psqlf >/dev/null 2>&1 <<SQL || FAILED=1
select set_config('test.user_id', '$A', false);
insert into public.inventory_skus (id, user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
  values ('$SKU_LOCK', '$A', '$ORG1', 900, 'LOCK', 'LOCK', 100, 0);
select public.lensed_add_batch('$SKU_LOCK', 5, 100);
SQL
BATCH_LOCK="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
  "select id from public.sku_batches where sku_id='$SKU_LOCK' limit 1")"

# Session A: hold the SKU's sale lock inside an open transaction for ~6s.
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock(hashtextextended('sku:'||'$SKU_LOCK'::uuid::text, 0));
select pg_sleep(6);
commit;
SQL
HOLDER_PID=$!

sleep 2  # let session A acquire the lock first

# Session B: the edit must BLOCK on that lock and get cancelled by statement_timeout.
LOCKLOG="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" 2>&1 <<SQL
set statement_timeout = '2500';
select set_config('test.user_id', '$A', false);
select public.lensed_edit_batch('$SKU_LOCK', '$BATCH_LOCK', 4, 100);
SQL
)"
if echo "$LOCKLOG" | grep -qiE "statement timeout|canceling statement"; then
  echo "  ✓ edit blocked on the held sku: lock (timed out waiting) — same lock key as live sales"
else
  echo "  ✗ edit did NOT block on the sku: lock — key mismatch? output:"; echo "$LOCKLOG"; FAILED=1
fi
wait "$HOLDER_PID" 2>/dev/null || true

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ ALL BATCH EDIT/DELETE TESTS PASSED"; else echo "❌ SOME TESTS FAILED"; fi
exit "$FAILED"
