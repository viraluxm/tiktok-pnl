#!/usr/bin/env bash
# Local DB verification for migration 138 (shift trades).
#
# Boots a THROWAWAY Postgres 16 in Docker, applies the shared stub bootstrap + the REAL repo
# migrations that build the pre-138 world (044/047/085/086/090/129/130), then applies the REAL 138
# file verbatim and runs the assertions. Requires Docker only. Mirrors ../schedule_phase2/run.sh.
#
#   usage:  supabase/tests/shift_trades/run.sh
#   exit:   0 = all passed, 1 = something failed
#
# NEVER points at a hosted database. No host, URL or credential input; nothing here reads .env.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P2="$SCRIPT_DIR/../schedule_phase2"
MIGDIR="$SCRIPT_DIR/../../migrations"
MIG138="$MIGDIR/138_shift_trades.sql"
CONTAINER="lensed_trades_test_$$"
IMAGE="postgres:16-alpine"
DB="db"
OWNER_A="a0000000-0000-4000-8000-000000000001"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
psqlq(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA "$@"; }

[ -f "$MIG138" ] || { echo "✗ migration not found: $MIG138"; exit 1; }

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || {
  echo "✗ could not start the container — is the Docker daemon running?"; exit 1; }
echo -n "▶ waiting for postgres"
ready=0; streak=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    streak=$((streak + 1)); [ "$streak" -ge 3 ] && { ready=1; break; }
  else streak=0; fi
  echo -n "."; sleep 1
done
[ "$ready" -eq 1 ] || { echo " NOT ready — aborting"; exit 1; }
echo " ready"
docker exec "$CONTAINER" createdb -U postgres "$DB" >/dev/null

echo "── bootstrap (stubs, shared with schedule_phase2) ──"
psqlf -q < "$P2/bootstrap.sql" >/dev/null || FAILED=1

echo "── apply real migrations 044, 047, 085, 086, 090 (the base world) ──"
for m in 044_create_employees_and_shifts 047_create_recurring_shifts \
         085_scheduling_v1_schema 086_collapse_shift_templates 090_shift_instances_admin_open; do
  if psqlf -q -1 < "$MIGDIR/$m.sql" >/dev/null 2>&1; then echo "  ✓ $m"
  else echo "  ✗ $m FAILED to apply"; FAILED=1; fi
done
echo "── apply real migrations 129, 130 VERBATIM (each carries its own begin/commit) ──"
for m in 129_schedule_phase2_offer_lifecycle 130_schedule_phase2_attendance_and_cancel; do
  if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIGDIR/$m.sql" >/dev/null 2>&1; then echo "  ✓ $m"
  else echo "  ✗ $m FAILED to apply"; FAILED=1; fi
done
[ "$FAILED" -eq 0 ] || { echo "❌ base schema failed — aborting"; exit 1; }

CATALOG_SQL="$SCRIPT_DIR/catalog.sql"
psqlf -q -f - < "$CATALOG_SQL" > /tmp/tr_before.$$ 2>&1

echo "── apply migration 138 VERBATIM (no -1: the file carries its own begin/commit) ──"
APPLY_LOG=/tmp/tr_apply.$$
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG138" >"$APPLY_LOG" 2>&1; then
  echo "  ✓ applied — ended with $(tail -1 "$APPLY_LOG")"
else
  echo "  ✗ MIGRATION FAILED TO APPLY:"; sed 's/^/    /' "$APPLY_LOG"; FAILED=1
fi
[ "$FAILED" -eq 0 ] || { echo "❌ migration did not apply — aborting"; exit 1; }

echo "── catalog: 138 must be purely ADDITIVE ──"
psqlf -q -f - < "$CATALOG_SQL" > /tmp/tr_after.$$ 2>&1
REMOVED=$(diff /tmp/tr_before.$$ /tmp/tr_after.$$ | grep '^<' || true)
if [ -z "$REMOVED" ]; then echo "  ✓ nothing dropped or narrowed on pre-existing tables"
else echo "  ✗ UNEXPECTED REMOVALS:"; echo "$REMOVED" | sed 's/^/    /'; FAILED=1; fi
for want in 'COL shift_trades.status' 'COL shift_trades.coworker_response' 'COL shift_trades.decided_by' \
            'shift_trades_status_check' 'shift_trades_response_check' 'shift_trades_two_people' 'shift_trades_two_shifts' \
            'shift_trades_manager_stage_has_acceptance' 'shift_trades_approved_is_decided' \
            'idx_shift_trades_live_requester_shift' 'idx_shift_trades_live_target_shift' 'idx_shift_trades_owner_status' \
            'POL shift_trades_own_rows' \
            'lensed_approve_shift_trade(uuid,uuid,date) sec=definer cfg=search_path=public'; do
  grep -qF "$want" /tmp/tr_after.$$ || { echo "  ✗ MISSING from catalog: $want"; FAILED=1; }
done
echo "  ✓ all expected objects present"

echo "── helpers + seed ──"
psqlf -q < "$P2/harness.sql"          >/dev/null || FAILED=1
psqlf -q < "$SCRIPT_DIR/harness.sql"  >/dev/null || FAILED=1
psqlf -q < "$P2/seed.sql"             >/dev/null || FAILED=1
psqlf -q < "$SCRIPT_DIR/seed.sql"     >/dev/null || FAILED=1

echo
echo "── shift_trades constraints ──"
psqlf -q < "$SCRIPT_DIR/test_constraints.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── RPC: happy path, same-day swap, replay, refusal paths ──"
psqlf -q < "$SCRIPT_DIR/test_rpc.sql"         2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── atomicity ──"
psqlf -q < "$SCRIPT_DIR/test_atomicity.sql"   2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1

# ── GRANTS ─────────────────────────────────────────────────────────────────────────────────────
echo "── grants: service_role ONLY ──"
FN='public.lensed_approve_shift_trade(uuid,uuid,date)'
for role in service_role authenticated anon public; do
  got=$(psqlq -c "select has_function_privilege('$role','$FN','execute')")
  want=$([ "$role" = "service_role" ] && echo t || echo f)
  if [ "$got" = "$want" ]; then echo "  ✓ $role EXECUTE = $got"
  else echo "  ✗ $role EXECUTE = $got (expected $want)"; FAILED=1; fi
done
for role in authenticated anon; do
  out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
        "set role $role; select public.lensed_approve_shift_trade('$OWNER_A'::uuid, gen_random_uuid(), date '2026-09-07');" 2>&1 || true)
  case "$out" in *"permission denied for function"*) echo "  ✓ SET ROLE $role → permission denied";;
                 *) echo "  ✗ SET ROLE $role was NOT blocked: $out"; FAILED=1;; esac
done
out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
      "set role service_role; select public.lensed_approve_shift_trade('$OWNER_A'::uuid, gen_random_uuid(), date '2026-09-07');" 2>&1 || true)
case "$out" in *TRADE_NOT_FOUND*) echo "  ✓ SET ROLE service_role → executes under SECURITY DEFINER";;
               *) echo "  ✗ service_role call failed: $out"; FAILED=1;; esac

# ── OUT-OF-TRANSACTION ROLLBACK (the real PostgREST shape) ─────────────────────────────────────
echo "── rollback in the real PostgREST shape (autocommit + fresh connection) ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.attendance_events; delete from public.shift_trades; delete from public.shift_instances;
create table if not exists race_ids(k text primary key, v uuid); truncate race_ids;
create or replace function t_boom() returns trigger language plpgsql as \$\$
begin if coalesce(current_setting('test.boom', true), '') = 'on' then raise exception 'BOOM'; end if; return new; end \$\$;
drop trigger if exists t_boom_attendance on public.attendance_events;
create trigger t_boom_attendance before insert on public.attendance_events for each row execute function t_boom();
with a as (insert into public.shift_instances(user_id,employee_id,shift_date,starts_at,ends_at,status)
           values ('$OWNER_A','e1111111-0000-4000-8000-000000000001','2027-06-01','2027-06-01 09:00Z','2027-06-01 17:00Z','scheduled') returning id),
     b as (insert into public.shift_instances(user_id,employee_id,shift_date,starts_at,ends_at,status)
           values ('$OWNER_A','e2222222-0000-4000-8000-000000000002','2027-06-03','2027-06-03 09:00Z','2027-06-03 17:00Z','scheduled') returning id),
     t as (insert into public.shift_trades(user_id,requester_employee_id,requester_shift_instance_id,target_employee_id,target_shift_instance_id,status,coworker_response,coworker_responded_at)
           select '$OWNER_A','e1111111-0000-4000-8000-000000000001',a.id,'e2222222-0000-4000-8000-000000000002',b.id,'pending_manager','accepted',now() from a,b returning id)
insert into race_ids(k,v) select 'a',id from a union all select 'b',id from b union all select 't',id from t;
SQL
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
  "set test.boom = 'on'; select public.lensed_approve_shift_trade('$OWNER_A'::uuid,(select v from race_ids where k='t'), date '2026-09-07')::text;" >/tmp/tr_tear.$$ 2>&1
grep -q 'BOOM' /tmp/tr_tear.$$ && echo "  ✓ post-swap error raised (not swallowed)" || { echo "  ✗ expected BOOM; got: $(cat /tmp/tr_tear.$$)"; FAILED=1; }
STILL=$(psqlq -c "select (select employee_id from public.shift_instances where id=(select v from race_ids where k='a'))::text||'|'||(select employee_id from public.shift_instances where id=(select v from race_ids where k='b'))::text")
[ "$STILL" = "e1111111-0000-4000-8000-000000000001|e2222222-0000-4000-8000-000000000002" ] \
  && echo "  ✓ fresh connection sees BOTH shifts unmoved" || { echo "  ✗ TORN STATE: $STILL"; FAILED=1; }
psqlq -c "drop trigger if exists t_boom_attendance on public.attendance_events" >/dev/null

# ── CONCURRENCY: two managers approve the SAME trade at once → exactly one swap, one approval ──
echo "── concurrency: simultaneous approvals of one trade serialize ──"
race(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select '$1 -> '||public.lensed_approve_shift_trade('$OWNER_A'::uuid,(select v from race_ids where k='t'), date '2026-09-07')::text;
select pg_sleep(1.5);
commit;
SQL
}
race m1 > /tmp/tr_m1.$$ 2>&1 & P1=$!
sleep 1
race m2 > /tmp/tr_m2.$$ 2>&1 & P2=$!
wait "$P1" "$P2" 2>/dev/null || true
grep -hE '^m[12] ->' /tmp/tr_m1.$$ /tmp/tr_m2.$$ | sed 's/^/    /'
OKS=$(cat /tmp/tr_m1.$$ /tmp/tr_m2.$$ | grep -c '"ok": true' || true)
EV=$(psqlq -c "select count(*) from public.attendance_events")
SWAPPED=$(psqlq -c "select (select employee_id from public.shift_instances where id=(select v from race_ids where k='a'))::text||'|'||(select employee_id from public.shift_instances where id=(select v from race_ids where k='b'))::text")
[ "$OKS" = "1" ] && echo "  ✓ exactly one approval succeeded" || { echo "  ✗ $OKS approvals succeeded"; FAILED=1; }
[ "$EV" = "4" ] && echo "  ✓ exactly four attendance rows (no double write)" || { echo "  ✗ $EV attendance rows"; FAILED=1; }
[ "$SWAPPED" = "e2222222-0000-4000-8000-000000000002|e1111111-0000-4000-8000-000000000001" ] \
  && echo "  ✓ swapped exactly once" || { echo "  ✗ unexpected state: $SWAPPED"; FAILED=1; }

# ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────
echo "── idempotence: re-apply 138 on top of itself ──"
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG138" >/dev/null 2>&1; then
  psqlf -q -f - < "$CATALOG_SQL" > /tmp/tr_after2.$$ 2>&1
  if diff -q /tmp/tr_after.$$ /tmp/tr_after2.$$ >/dev/null; then echo "  ✓ re-apply clean; catalog byte-identical"
  else echo "  ✗ catalog DRIFTED on re-apply:"; diff /tmp/tr_after.$$ /tmp/tr_after2.$$ | sed 's/^/    /'; FAILED=1; fi
else echo "  ✗ re-apply FAILED"; FAILED=1; fi

rm -f /tmp/tr_*.$$
echo
if [ "$FAILED" -eq 0 ]; then echo "✅ SHIFT TRADES (migration 138) DB TESTS PASSED"
else echo "❌ SHIFT TRADES DB TESTS FAILED"; fi
exit "$FAILED"
