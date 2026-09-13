#!/usr/bin/env bash
# Local verification for migration 155 (legacy $0 -> post-152 model).
# Applies the REAL stack in production order, then the behavioural assertions.
#   bootstrap -> 083 -> 105 -> 103 + pnl_order_grain -> 152 -> 153 -> 154 -> 155 -> test.sql
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGS="$SCRIPT_DIR/../../migrations"
FIFO="$SCRIPT_DIR/../fifo_source_batch"
CONTAINER="lensed_legacy_zero_$$"; DB="db_legacy_zero"; FAILED=0
cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "▶ starting postgres:16-alpine ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres postgres:16-alpine >/dev/null
printf '▶ waiting'; READY=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    READY=$((READY+1)); [ "$READY" -ge 2 ] && break
  else READY=0; fi
  printf '.'; sleep 1
done
[ "$READY" -lt 2 ] && { echo " ✗ never ready"; exit 1; }
echo " ready"
docker exec "$CONTAINER" createdb -U postgres "$DB" >/dev/null

echo "── base schema + pre-feature RPCs ──"
psqlf < "$FIFO/bootstrap.sql" >/dev/null || FAILED=1
psqlf -1 < "$MIGS/083_fifo_batch_edit_delete.sql" >/dev/null || FAILED=1
psqlf -1 < "$MIGS/105_bind_records_short_at_bind.sql" >/dev/null || FAILED=1
psqlf -1 < "$MIGS/103_platform_fee_centralization.sql" >/dev/null || FAILED=1
psqlf -1 < "$FIFO/pnl_order_grain.prodview.sql" >/dev/null || FAILED=1

echo "── seed the PRE-152 legacy world (real binds through the OLD RPC) ──"
psqlf < "$SCRIPT_DIR/seed_legacy_zero.sql" >/dev/null || FAILED=1

echo "── apply 152 + 153 + 154 + 155 ──"
for m in 152_fifo_batch_cost_state_and_attribution 153_fifo_record_source_batch \
         154_fifo_finalize_batch_cost 155_legacy_zero_cost_reconciliation; do
  psqlf -1 < "$MIGS/$m.sql" >/dev/null || { echo "  ✗ failed to apply $m"; FAILED=1; }
done
echo "── idempotency: re-apply 155 ──"
psqlf -1 < "$MIGS/155_legacy_zero_cost_reconciliation.sql" >/dev/null \
  && echo "  ✓ 155 re-applies cleanly" || { echo "  ✗ 155 not idempotent"; FAILED=1; }

echo "── behavioural assertions ──"
psqlf < "$SCRIPT_DIR/test.sql" || FAILED=1

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ ALL LEGACY \$0 RECONCILIATION TESTS PASSED"; else echo "❌ SOME TESTS FAILED"; fi
exit "$FAILED"
