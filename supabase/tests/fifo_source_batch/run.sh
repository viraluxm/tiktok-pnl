#!/usr/bin/env bash
# Local verification for migrations 149 + 150 (FIFO source-batch attribution, explicit
# batch cost state, authoritative received quantity).
#
# Boots a throwaway Postgres in Docker and applies the REAL migration stack in the real
# order, with the legacy world seeded in between so the "migration did not touch history"
# assertions are made against rows that genuinely predate it:
#
#   bootstrap.sql -> 083 -> 105 -> seed_legacy.sql -> 149 -> 150 -> 151
#     -> 103 + pnl_order_grain (the REAL reporting surfaces) -> test.sql -> test_finalize.sql
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
# NB: pg_isready alone is NOT enough. During initdb the image runs a TEMPORARY server on
# the unix socket and then restarts it, so pg_isready can report ready, the socket vanish,
# and every following psql fail with "No such file or directory". Require a real query to
# succeed twice in a row before continuing.
echo -n "▶ waiting for postgres"
READY=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    READY=$((READY+1)); [ "$READY" -ge 2 ] && break
  else
    READY=0
  fi
  echo -n "."; sleep 1
done
if [ "$READY" -lt 2 ]; then echo " ✗ postgres never became ready"; exit 1; fi
echo " ready"
docker exec "$CONTAINER" createdb -U postgres "$DB" >/dev/null || { echo "✗ createdb failed"; exit 1; }

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

echo "── apply 151 (finalize/correct batch cost + historical backfill) ──"
psqlf -1 < "$MIGS/151_fifo_finalize_batch_cost.sql" || FAILED=1

# The reporting layer, installed from the REAL sources so the propagation test proves
# something rather than re-implementing anyone's arithmetic: migration 103 owns every
# repo-defined P&L function, and pnl_order_grain is prod-only (see
# docs/runbooks/prod-only-cost-objects.md) so it comes from the captured live viewdef.
echo "── install P&L surfaces: migration 103 + the prod-only pnl_order_grain view ──"
psqlf -1 < "$MIGS/103_platform_fee_centralization.sql" >/dev/null || FAILED=1
psqlf -1 < "$SCRIPT_DIR/pnl_order_grain.prodview.sql" >/dev/null || FAILED=1

echo "── idempotency: re-applying 151 must be a no-op ──"
psqlf -1 < "$MIGS/151_fifo_finalize_batch_cost.sql" >/dev/null \
  && echo "  ✓ 151 re-applies cleanly" || { echo "  ✗ 151 is NOT idempotent"; FAILED=1; }

echo "── behavioral assertions (test.sql) ──"
psqlf < "$SCRIPT_DIR/test.sql" || FAILED=1
echo "── finalize / backfill assertions (test_finalize.sql) ──"
psqlf < "$SCRIPT_DIR/test_finalize.sql" || FAILED=1

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

# ── TEST 8 part 1: a finalize must BLOCK on the same per-SKU advisory lock ───────────
echo "── T8a: finalize blocks on the held sku: lock ──"
SKU_FIN="cccccccc-cccc-cccc-cccc-cccccccccccc"
SESS_F="dddddddd-dddd-dddd-dddd-dddddddddddd"
psqlf >/dev/null 2>&1 <<SQL || FAILED=1
select set_config('test.user_id', '$A', false);
insert into public.inventory_skus (id, user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
  values ('$SKU_FIN', '$A', '$ORG1', 700, 'FIN', 'FIN', null, 0);
insert into public.live_sessions (id, user_id, status, started_at) values ('$SESS_F', '$A', 'live', now());
select public.lensed_add_batch('$SKU_FIN', 30, null);
SQL
BATCH_FIN="$(q "select id from public.sku_batches where sku_id='$SKU_FIN' limit 1")"

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock(hashtextextended('sku:'||'$SKU_FIN'::uuid::text, 0));
select pg_sleep(6);
commit;
SQL
HOLDER2=$!
sleep 2
FINLOG="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" 2>&1 <<SQL
set statement_timeout = '2500';
select set_config('test.user_id', '$A', false);
select * from public.lensed_finalize_batch_cost('$SKU_FIN'::uuid, '$BATCH_FIN'::uuid, 340);
SQL
)"
if echo "$FINLOG" | grep -qiE "statement timeout|canceling statement"; then
  echo "  ✓ finalize blocked on the held sku: lock — it cannot interleave with a draw"
else
  echo "  ✗ finalize did NOT block. output:"; echo "$FINLOG"; FAILED=1
fi
wait "$HOLDER2" 2>/dev/null || true

# ── TEST 8 part 2: sales racing a finalize — no sale may escape BOTH paths ───────────
# 15 qty-1 binds from 3 shells while a finalize runs concurrently. Every sale must end
# either (a) bound first, then repriced by the finalize, or (b) bound after it, snapshotting
# the finalized cost directly. Either way EVERY attributed line must read 340 at the end —
# that single assertion is what "no sale escapes both paths" means operationally.
echo "── T8b: 15 sales racing a finalize ──"
for shell in 1 2 3; do
  (
    for i in 1 2 3 4 5; do
      docker exec -i "$CONTAINER" psql -U postgres -d "$DB" >/dev/null 2>&1 <<SQL
select set_config('test.user_id', '$A', false);
select * from public.lensed_log_auction('$SESS_F'::uuid, 'sold',
  '[{"sku_id":"$SKU_FIN","qty":1}]'::jsonb, 'T8-$shell-$i', false, false);
SQL
    done
  ) &
done
(
  sleep 1
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" >/dev/null 2>&1 <<SQL
select set_config('test.user_id', '$A', false);
select * from public.lensed_finalize_batch_cost('$SKU_FIN'::uuid, '$BATCH_FIN'::uuid, 340);
SQL
) &
wait

T8RES="$(q "
select (select count(*) from public.live_auction_item_skus where source_batch_id='$BATCH_FIN'),
       (select count(*) from public.live_auction_item_skus where source_batch_id='$BATCH_FIN' and unit_cost_cents_snapshot is distinct from 340),
       (select qty_remaining from public.sku_batches where id='$BATCH_FIN'),
       (select qty_on_hand from public.inventory_skus where id='$SKU_FIN'),
       (select unit_cost_cents from public.sku_batches where id='$BATCH_FIN');
")"
IFS='|' read -r T8LINES T8BAD T8REM T8QOH T8COST <<< "$T8RES"
echo "     attributed_lines=$T8LINES  not_at_340=$T8BAD  qty_remaining=$T8REM  qty_on_hand=$T8QOH  batch_cost=$T8COST"
if [ -z "$T8LINES" ] || [ "$T8LINES" -eq 0 ]; then echo "  ✗ VACUOUS — no sales were attributed"; FAILED=1
elif [ "$T8LINES" != "15" ]; then echo "  ✗ expected 15 attributed sales, got $T8LINES"; FAILED=1
elif [ "$T8BAD" != "0" ]; then echo "  ✗ $T8BAD sale(s) ESCAPED both paths (snapshot != 340)"; FAILED=1
elif [ "$T8REM" != "15" ] || [ "$T8QOH" != "15" ]; then echo "  ✗ quantities wrong: remaining=$T8REM qty_on_hand=$T8QOH"; FAILED=1
elif [ "$T8COST" != "340" ]; then echo "  ✗ batch cost is $T8COST"; FAILED=1
else echo "  ✓ all 15 racing sales end at 340 — repriced if earlier, snapshotted if later; quantities exact"; fi

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ ALL FIFO SOURCE-BATCH + FINALIZE TESTS PASSED"; else echo "❌ SOME TESTS FAILED"; fi
exit "$FAILED"
