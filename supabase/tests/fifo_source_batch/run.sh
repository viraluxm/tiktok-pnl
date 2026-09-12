#!/usr/bin/env bash
# Local verification for migrations 149 + 150 (FIFO source-batch attribution, explicit
# batch cost state, authoritative received quantity).
#
# Boots a throwaway Postgres in Docker and applies the REAL migration stack in the real
# order, with the legacy world seeded in between so the "migration did not touch history"
# assertions are made against rows that genuinely predate it:
#
#   bootstrap.sql -> 083 -> 105 -> seed_legacy.sql -> 149 -> 150 -> test.sql
#
# Then two live concurrency proofs (Test G) that cannot be written in a single session.
# Requires Docker; no host psql (runs psql inside the container). Mirrors ../batch_edit_delete/run.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGS="$SCRIPT_DIR/../../migrations"
CONTAINER="lensed_fifo_attr_test_$$"
IMAGE="postgres:16-alpine"
DB="db_fifo_attr"
A="11111111-1111-1111-1111-111111111111"
ORG1="22222222-2222-2222-2222-222222222222"
SKU_LOCK="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SESS_C="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
q(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c "$1"; }

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
echo -n "▶ waiting for postgres"
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  echo -n "."; sleep 1
done
echo " ready"
docker exec "$CONTAINER" createdb -U postgres "$DB" >/dev/null

echo "── bootstrap base schema (inventory + FIFO + full auction chain) ──"
psqlf < "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1
echo "── apply 083 (batch add/edit/delete RPCs) ──"
psqlf -1 < "$MIGS/083_fifo_batch_edit_delete.sql" >/dev/null || FAILED=1
echo "── apply 105 (the bind RPCs — the real FIFO draw) ──"
psqlf -1 < "$MIGS/105_bind_records_short_at_bind.sql" >/dev/null || FAILED=1
echo "── seed the PRE-149 legacy world (batches + real binds + snapshots) ──"
psqlf < "$SCRIPT_DIR/seed_legacy.sql" >/dev/null || FAILED=1
echo "── apply 149 (schema: cost_status, qty_added_authoritative, source_batch_id) ──"
psqlf -1 < "$MIGS/149_fifo_batch_cost_state_and_attribution.sql" || FAILED=1
echo "── apply 150 (RPCs populate them) ──"
psqlf -1 < "$MIGS/150_fifo_record_source_batch.sql" || FAILED=1

echo "── idempotency: re-applying 149 must be a no-op ──"
psqlf -1 < "$MIGS/149_fifo_batch_cost_state_and_attribution.sql" >/dev/null \
  && echo "  ✓ 149 re-applies cleanly" || { echo "  ✗ 149 is NOT idempotent"; FAILED=1; }

echo "── behavioral assertions (test.sql) ──"
psqlf < "$SCRIPT_DIR/test.sql" || FAILED=1

# ── TEST G part 1: a bind must BLOCK on the same per-SKU advisory lock ───────────────
echo "── G1: a live bind blocks on the held sku: lock ──"
psqlf >/dev/null 2>&1 <<SQL || FAILED=1
select set_config('test.user_id', '$A', false);
insert into public.inventory_skus (id, user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
  values ('$SKU_LOCK', '$A', '$ORG1', 800, 'LOCK', 'LOCK', 100, 0);
insert into public.live_sessions (id, user_id, status) values ('$SESS_C', '$A', 'live');
select public.lensed_add_batch('$SKU_LOCK', 6, 100);
select public.lensed_add_batch('$SKU_LOCK', 9, 200);
SQL

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock(hashtextextended('sku:'||'$SKU_LOCK'::uuid::text, 0));
select pg_sleep(6);
commit;
SQL
HOLDER_PID=$!
sleep 2

LOCKLOG="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" 2>&1 <<SQL
set statement_timeout = '2500';
select set_config('test.user_id', '$A', false);
select * from public.lensed_log_auction('$SESS_C', 'sold',
  '[{"sku_id":"$SKU_LOCK","qty":1}]'::jsonb, 'G-blocked', false, false);
SQL
)"
if echo "$LOCKLOG" | grep -qiE "statement timeout|canceling statement"; then
  echo "  ✓ bind blocked on the held sku: lock — a cost/qty edit cannot interleave with a draw"
else
  echo "  ✗ bind did NOT block. output:"; echo "$LOCKLOG"; FAILED=1
fi
wait "$HOLDER_PID" 2>/dev/null || true

# ── TEST G part 2: attribution survives genuinely concurrent binds ───────────────────
# 15 units across two layers (6 @100, 9 @200); three shells race 5 binds each. Afterwards
# every sale must name the layer that actually lost the units.
echo "── G2: 15 concurrent binds across 2 layers — attribution vs. quantity ──"
for shell in 1 2 3; do
  (
    for i in 1 2 3 4 5; do
      docker exec -i "$CONTAINER" psql -U postgres -d "$DB" >/dev/null 2>&1 <<SQL
select set_config('test.user_id', '$A', false);
select * from public.lensed_log_auction('$SESS_C', 'sold',
  '[{"sku_id":"$SKU_LOCK","qty":1}]'::jsonb, 'G2-$shell-$i', false, false);
SQL
    done
  ) &
done
wait

GRES="$(q "
with per_batch as (
  select b.id, b.qty_added - b.qty_remaining as moved,
         coalesce((select sum(l.qty) from public.live_auction_item_skus l where l.source_batch_id = b.id), 0) as attributed
  from public.sku_batches b where b.sku_id = '$SKU_LOCK'
)
select (select count(*) from per_batch),
       (select count(*) from per_batch where moved <> attributed),
       (select sum(moved) from per_batch),
       (select sum(attributed) from per_batch),
       (select qty_on_hand from public.inventory_skus where id = '$SKU_LOCK'),
       (select sum(qty_remaining) from public.sku_batches where sku_id = '$SKU_LOCK');
")"
IFS='|' read -r NB MISMATCH MOVED ATTR QOH SUMREM <<< "$GRES"
echo "     layers=$NB  mismatched=$MISMATCH  units_moved=$MOVED  units_attributed=$ATTR  qty_on_hand=$QOH  sum(qty_remaining)=$SUMREM"
if [ "$NB" -eq 0 ]; then echo "  ✗ VACUOUS — no layers examined"; FAILED=1
elif [ "$MISMATCH" != "0" ]; then echo "  ✗ $MISMATCH layer(s) where units moved != units attributed"; FAILED=1
elif [ "$MOVED" != "15" ] || [ "$ATTR" != "15" ]; then echo "  ✗ expected 15 units moved and attributed, got $MOVED/$ATTR"; FAILED=1
elif [ "$QOH" != "$SUMREM" ]; then echo "  ✗ 034 lockstep invariant broken: qty_on_hand=$QOH vs Σqty_remaining=$SUMREM"; FAILED=1
else echo "  ✓ every unit that left a layer is attributed to THAT layer; qty_on_hand stays in lockstep"; fi

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ ALL FIFO SOURCE-BATCH TESTS PASSED"; else echo "❌ SOME TESTS FAILED"; fi
exit "$FAILED"
