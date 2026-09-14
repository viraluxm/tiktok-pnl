#!/usr/bin/env bash
# Local DB verification for migration 156 (staffing capacity → automatic Available Shifts).
#
# Boots a THROWAWAY Postgres 16 in Docker, applies the shared stub bootstrap + the REAL repo
# migrations that build the pre-156 world (044/047/085/086/090/129/130), then applies the REAL 156
# file verbatim and runs the assertions. Requires Docker only. Mirrors ../shift_trades/run.sh.
#
#   usage:  supabase/tests/schedule_capacity/run.sh
#   exit:   0 = all passed, 1 = something failed
#
# NEVER points at a hosted database. No host, URL or credential input; nothing here reads .env.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P2="$SCRIPT_DIR/../schedule_phase2"
MIGDIR="$SCRIPT_DIR/../../migrations"
MIG156="$MIGDIR/156_shift_capacity_blocks.sql"
MIG157="$MIGDIR/157_schedule_capacity_write_guard.sql"
CONTAINER="lensed_capacity_test_$$"
IMAGE="postgres:16-alpine"
DB="db"
OWNER_A="a0000000-0000-4000-8000-000000000001"
NIGHT="b1000000-0000-4000-8000-000000000001"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
psqlq(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA "$@"; }

[ -f "$MIG156" ] || { echo "✗ migration not found: $MIG156"; exit 1; }
[ -f "$MIG157" ] || { echo "✗ migration not found: $MIG157"; exit 1; }

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
# The business timezone is a server-fixed constant in app code; the RPC names it explicitly, so the
# container's own TimeZone must never be what makes the test pass.
psqlq -c "alter database $DB set timezone to 'UTC'" >/dev/null

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
psqlf -q -f - < "$CATALOG_SQL" > /tmp/cap_before.$$ 2>&1

echo "── apply migration 156 VERBATIM (no -1: the file carries its own begin/commit blocks) ──"
APPLY_LOG=/tmp/cap_apply.$$
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG156" >"$APPLY_LOG" 2>&1; then
  echo "  ✓ applied — ended with $(tail -1 "$APPLY_LOG")"
else
  echo "  ✗ MIGRATION FAILED TO APPLY:"; sed 's/^/    /' "$APPLY_LOG"; FAILED=1
fi
[ "$FAILED" -eq 0 ] || { echo "❌ migration did not apply — aborting"; exit 1; }

echo "── apply migration 157 VERBATIM (the capacity WRITE guard; depends on 156) ──"
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG157" >/tmp/cap_apply157.$$ 2>&1; then
  echo "  ✓ applied — ended with $(tail -1 /tmp/cap_apply157.$$)"
else
  echo "  ✗ MIGRATION 157 FAILED TO APPLY:"; sed 's/^/    /' /tmp/cap_apply157.$$; FAILED=1
fi
[ "$FAILED" -eq 0 ] || { echo "❌ migration 157 did not apply — aborting"; exit 1; }

echo "── catalog: 156 must be purely ADDITIVE (nothing dropped or narrowed) ──"
psqlf -q -f - < "$CATALOG_SQL" > /tmp/cap_after.$$ 2>&1
REMOVED=$(diff /tmp/cap_before.$$ /tmp/cap_after.$$ | grep '^<' || true)
if [ -z "$REMOVED" ]; then echo "  ✓ nothing dropped or narrowed on pre-existing tables"
else echo "  ✗ UNEXPECTED REMOVALS:"; echo "$REMOVED" | sed 's/^/    /'; FAILED=1; fi
for want in 'COL shift_capacity_blocks.days_of_week' 'COL shift_capacity_settings.closed' 'COL shift_requests.shift_instance_id' \
            'shift_capacity_blocks_team_check' 'shift_capacity_blocks_times_differ' 'shift_capacity_blocks_days_valid' \
            'shift_capacity_settings_shape' 'shift_capacity_settings_team_default_is_meaningful' \
            'shift_requests_status_check' 'shift_requests_approved_has_instance' 'shift_requests_span_ordered' \
            'idx_shift_capacity_settings_team_default' 'idx_shift_capacity_settings_block_date' \
            'idx_shift_requests_one_pending_per_day' 'idx_shift_instances_owner_span' \
            'RLS shift_capacity_blocks t' 'RLS shift_capacity_settings t' 'RLS shift_requests t' \
            'POL shift_requests shift_requests_own_rows' \
            'lensed_approve_shift_request(uuid,uuid) sec=definer cfg=search_path=public' \
            'lensed_apply_schedule_batch(uuid,jsonb,uuid[],uuid[]) sec=definer cfg=search_path=public' \
            'lensed_assign_released_shift(uuid,uuid,uuid) sec=definer cfg=search_path=public'; do
  grep -qF "$want" /tmp/cap_after.$$ || { echo "  ✗ MISSING from catalog: $want"; FAILED=1; }
done
echo "  ✓ all expected objects present"
# The shipped scheduling tables must be untouched — 156 adds one INDEX to shift_instances and
# nothing else, and shift_claims is not touched at all.
CLAIMCOLS_B=$(grep -c '^PRE public.shift_claims' /tmp/cap_before.$$ || true)
CLAIMCOLS_A=$(grep -c '^PRE public.shift_claims' /tmp/cap_after.$$ || true)
[ "$CLAIMCOLS_B" = "$CLAIMCOLS_A" ] && echo "  ✓ shift_claims constraint set unchanged ($CLAIMCOLS_A)" \
  || { echo "  ✗ shift_claims constraints changed: $CLAIMCOLS_B → $CLAIMCOLS_A"; FAILED=1; }

echo "── helpers + seed ──"
psqlf -q < "$P2/harness.sql"          >/dev/null || FAILED=1
psqlf -q < "$P2/seed.sql"             >/dev/null || FAILED=1
psqlf -q < "$SCRIPT_DIR/harness.sql"  >/dev/null || FAILED=1
psqlf -q < "$SCRIPT_DIR/seed.sql"     >/dev/null || FAILED=1

echo
echo "── 156 constraints ──"
psqlf -q < "$SCRIPT_DIR/test_constraints.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── RPC: happy path, replay, capacity, overrides, refusals, owner isolation ──"
psqlf -q < "$SCRIPT_DIR/test_rpc.sql"         2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── 157 write guard: batch, partial refusal, over-capacity, overlap, legacy board ──"
psqlf -q < "$SCRIPT_DIR/test_write_guard.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1

# ── GRANTS ─────────────────────────────────────────────────────────────────────────────────────
echo "── grants: service_role ONLY ──"
FN='public.lensed_approve_shift_request(uuid,uuid)'
for role in service_role authenticated anon public; do
  got=$(psqlq -c "select has_function_privilege('$role','$FN','execute')")
  want=$([ "$role" = "service_role" ] && echo t || echo f)
  if [ "$got" = "$want" ]; then echo "  ✓ $role EXECUTE = $got"
  else echo "  ✗ $role EXECUTE = $got (expected $want)"; FAILED=1; fi
done
for role in authenticated anon; do
  out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
        "set role $role; select public.lensed_approve_shift_request('$OWNER_A'::uuid, gen_random_uuid());" 2>&1 || true)
  case "$out" in *"permission denied for function"*) echo "  ✓ SET ROLE $role → permission denied";;
                 *) echo "  ✗ SET ROLE $role was NOT blocked: $out"; FAILED=1;; esac
done
out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
      "set role service_role; select public.lensed_approve_shift_request('$OWNER_A'::uuid, gen_random_uuid());" 2>&1 || true)
case "$out" in *REQUEST_NOT_FOUND*) echo "  ✓ SET ROLE service_role → executes under SECURITY DEFINER";;
               *) echo "  ✗ service_role call failed: $out"; FAILED=1;; esac

# ── CONCURRENCY — THE POINT OF THE ADVISORY LOCK ───────────────────────────────────────────────
# Two managers approve two DIFFERENT employees into the LAST remaining shift, at the same instant.
# Exactly one must win; the other must get NO_CAPACITY. 11/10 scheduled is the failure this exists
# to prevent. Backgrounded psql sessions with an overlapping hold, the same shape ../shift_trades
# uses for its trade race.
echo "── concurrency: two managers approve the final shift at once ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.shift_requests; delete from public.shift_instances;
create table if not exists race_ids(k text primary key, v uuid); truncate race_ids;
-- Capacity 3 with two already scheduled ⇒ exactly ONE shift left.
insert into race_ids(k,v) values
  ('a', mkspan('e1111111-0000-4000-8000-000000000001', date '2027-07-14', time '18:00', time '02:00')),
  ('b', mkspan('e2222222-0000-4000-8000-000000000002', date '2027-07-14', time '18:00', time '02:00')),
  ('r1', mkreq('e3333333-0000-4000-8000-000000000003','$NIGHT', date '2027-07-14')),
  ('r2', mkreq('e7777777-0000-4000-8000-000000000007','$NIGHT', date '2027-07-14'));
SQL
BEFORE=$(psqlq -c "select staffed_in('$OWNER_A'::uuid,'$NIGHT'::uuid, date '2027-07-14')")
[ "$BEFORE" = "2" ] && echo "  ✓ start state: 2 of 3 scheduled, one shift available" \
  || { echo "  ✗ start state is $BEFORE, expected 2"; FAILED=1; }

race(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select '$1 -> '||public.lensed_approve_shift_request('$OWNER_A'::uuid,(select v from race_ids where k='$2'))::text;
select pg_sleep(1.5);
commit;
SQL
}
race m1 r1 > /tmp/cap_m1.$$ 2>&1 & P1=$!
sleep 1
race m2 r2 > /tmp/cap_m2.$$ 2>&1 & P2=$!
wait "$P1" "$P2" 2>/dev/null || true
grep -hE '^m[12] ->' /tmp/cap_m1.$$ /tmp/cap_m2.$$ | sed 's/^/    /'
OKS=$(cat /tmp/cap_m1.$$ /tmp/cap_m2.$$ | grep -c '"ok": true' || true)
NOCAP=$(cat /tmp/cap_m1.$$ /tmp/cap_m2.$$ | grep -c 'NO_CAPACITY' || true)
AFTER=$(psqlq -c "select staffed_in('$OWNER_A'::uuid,'$NIGHT'::uuid, date '2027-07-14')")
APPROVED=$(psqlq -c "select count(*) from public.shift_requests where status='approved'")
[ "$OKS" = "1" ]    && echo "  ✓ exactly one approval succeeded" || { echo "  ✗ $OKS approvals succeeded"; FAILED=1; }
[ "$NOCAP" = "1" ]  && echo "  ✓ the loser got NO_CAPACITY (not a crash, not a silent success)" || { echo "  ✗ $NOCAP NO_CAPACITY refusals"; FAILED=1; }
[ "$AFTER" = "3" ]  && echo "  ✓ final staffing is 3 of 3 — never 4 of 3" || { echo "  ✗ final staffing is $AFTER, expected 3"; FAILED=1; }
[ "$APPROVED" = "1" ] && echo "  ✓ exactly one request is approved" || { echo "  ✗ $APPROVED approved requests"; FAILED=1; }

# ── CONCURRENCY 2 — APPROVAL vs BULK SCHEDULE, on the last remaining setup ─────────────────────
# The residual 156 documented. One session approves a shift request while the other bulk-schedules
# somebody into the same block at the same instant. Exactly one may win.
echo "── concurrency: an approval and a bulk schedule race for the final shift ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.shift_requests; delete from public.shift_instances;
truncate race_ids;
insert into race_ids(k,v) values
  ('a', mkspan('e1111111-0000-4000-8000-000000000001', date '2027-07-21', time '18:00', time '02:00')),
  ('b', mkspan('e2222222-0000-4000-8000-000000000002', date '2027-07-21', time '18:00', time '02:00')),
  ('r1', mkreq('e3333333-0000-4000-8000-000000000003','$NIGHT', date '2027-07-21'));
SQL
BEFORE=$(psqlq -c "select staffed_in('$OWNER_A'::uuid,'$NIGHT'::uuid, date '2027-07-21')")
[ "$BEFORE" = "2" ] && echo "  ✓ start state: 2 of 3 scheduled, one shift available" \
  || { echo "  ✗ start state is $BEFORE, expected 2"; FAILED=1; }

approve_race(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select 'approve -> '||public.lensed_approve_shift_request('$OWNER_A'::uuid,(select v from race_ids where k='r1'))::text;
select pg_sleep(1.5);
commit;
SQL
}
batch_race(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select 'batch -> '||public.lensed_apply_schedule_batch('$OWNER_A'::uuid,
  jsonb_build_array(jsonb_build_object(
    'employee_id','e7777777-0000-4000-8000-000000000007','shift_date',date '2027-07-21',
    'starts_at',(date '2027-07-21' + time '18:00') at time zone 'America/Los_Angeles',
    'ends_at',(date '2027-07-22' + time '02:00') at time zone 'America/Los_Angeles',
    'status','scheduled','source','admin_open','shift_rule_id',null,'store_id',null,'role','host')),
  '{}', '{}')::text;
select pg_sleep(1.5);
commit;
SQL
}
approve_race > /tmp/cap_ap.$$ 2>&1 & P1=$!
sleep 1
batch_race  > /tmp/cap_ba.$$ 2>&1 & P2=$!
wait "$P1" "$P2" 2>/dev/null || true
grep -hE '^(approve|batch) ->' /tmp/cap_ap.$$ /tmp/cap_ba.$$ | cut -c1-160 | sed 's/^/    /'
AFTER=$(psqlq -c "select staffed_in('$OWNER_A'::uuid,'$NIGHT'::uuid, date '2027-07-21')")
APPROVED=$(psqlq -c "select count(*) from public.shift_requests where status='approved'")
REFUSED=$(cat /tmp/cap_ap.$$ /tmp/cap_ba.$$ | grep -c -E 'NO_CAPACITY|OVER_CAPACITY' || true)
[ "$AFTER" = "3" ]   && echo "  ✓ final staffing is 3 of 3 — never 4 of 3" || { echo "  ✗ final staffing is $AFTER"; FAILED=1; }
[ "$REFUSED" = "1" ] && echo "  ✓ exactly one of the two was refused" || { echo "  ✗ $REFUSED refusals"; FAILED=1; }

# ── CONCURRENCY 3 — TWO SIMULTANEOUS BULK WRITES into the same block ──────────────────────────
echo "── concurrency: two bulk schedules race for the final shift ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.shift_requests; delete from public.shift_instances;
select mkspan('e1111111-0000-4000-8000-000000000001', date '2027-07-28', time '18:00', time '02:00');
select mkspan('e2222222-0000-4000-8000-000000000002', date '2027-07-28', time '18:00', time '02:00');
SQL
bw(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select '$1 -> '||public.lensed_apply_schedule_batch('$OWNER_A'::uuid,
  jsonb_build_array(jsonb_build_object(
    'employee_id','$2','shift_date',date '2027-07-28',
    'starts_at',(date '2027-07-28' + time '18:00') at time zone 'America/Los_Angeles',
    'ends_at',(date '2027-07-29' + time '02:00') at time zone 'America/Los_Angeles',
    'status','scheduled','source','admin_open','shift_rule_id',null,'store_id',null,'role','host')),
  '{}', '{}')::text;
select pg_sleep(1.5);
commit;
SQL
}
bw w1 e3333333-0000-4000-8000-000000000003 > /tmp/cap_w1.$$ 2>&1 & P1=$!
sleep 1
bw w2 e7777777-0000-4000-8000-000000000007 > /tmp/cap_w2.$$ 2>&1 & P2=$!
wait "$P1" "$P2" 2>/dev/null || true
grep -hE '^w[12] ->' /tmp/cap_w1.$$ /tmp/cap_w2.$$ | cut -c1-160 | sed 's/^/    /'
AFTER2=$(psqlq -c "select staffed_in('$OWNER_A'::uuid,'$NIGHT'::uuid, date '2027-07-28')")
CREATED=$(cat /tmp/cap_w1.$$ /tmp/cap_w2.$$ | grep -o '"created": 1' | wc -l | tr -d ' ')
OVER=$(cat /tmp/cap_w1.$$ /tmp/cap_w2.$$ | grep -c 'OVER_CAPACITY' || true)
[ "$AFTER2" = "3" ]  && echo "  ✓ final staffing is 3 of 3 — never 4 of 3" || { echo "  ✗ final staffing is $AFTER2"; FAILED=1; }
[ "$CREATED" = "1" ] && echo "  ✓ exactly one batch created a shift" || { echo "  ✗ $CREATED batches created a shift"; FAILED=1; }
[ "$OVER" = "1" ]    && echo "  ✓ the loser got OVER_CAPACITY, and its OTHER rows would still have saved" || { echo "  ✗ $OVER OVER_CAPACITY refusals"; FAILED=1; }

# ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────
echo "── idempotence: re-apply 156 + 157 on top of themselves ──"
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG156" >/dev/null 2>&1 \
   && docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG157" >/dev/null 2>&1; then
  psqlf -q -f - < "$CATALOG_SQL" > /tmp/cap_after2.$$ 2>&1
  if diff -q /tmp/cap_after.$$ /tmp/cap_after2.$$ >/dev/null; then echo "  ✓ re-apply clean; catalog byte-identical"
  else echo "  ✗ catalog DRIFTED on re-apply:"; diff /tmp/cap_after.$$ /tmp/cap_after2.$$ | sed 's/^/    /'; FAILED=1; fi
else echo "  ✗ re-apply FAILED"; FAILED=1; fi

# ── ROLLBACK ───────────────────────────────────────────────────────────────────────────────────
echo "── rollback: 157 then 156 restores the pre-156 catalog ──"
ROLLBACK="$SCRIPT_DIR/../../rollbacks/156_rollback.sql"
ROLLBACK157="$SCRIPT_DIR/../../rollbacks/157_rollback.sql"
if [ -f "$ROLLBACK" ] && [ -f "$ROLLBACK157" ] \
   && docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$ROLLBACK157" >/dev/null 2>&1 \
   && docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$ROLLBACK" >/dev/null 2>&1; then
  psqlf -q -f - < "$CATALOG_SQL" > /tmp/cap_rolled.$$ 2>&1
  if diff -q /tmp/cap_before.$$ /tmp/cap_rolled.$$ >/dev/null; then echo "  ✓ catalog is byte-identical to pre-156"
  else echo "  ✗ rollback left drift:"; diff /tmp/cap_before.$$ /tmp/cap_rolled.$$ | sed 's/^/    /'; FAILED=1; fi
  # The shifts an approval created are DELIBERATELY kept — they are real scheduled work.
  KEPT=$(psqlq -c "select count(*) from public.shift_instances where source='admin_open'")
  [ "$KEPT" -ge 1 ] && echo "  ✓ approved shifts survive the rollback ($KEPT) — they are real scheduled work" \
    || { echo "  ✗ rollback removed scheduled shifts"; FAILED=1; }
else echo "  ✗ rollback FAILED to apply"; FAILED=1; fi

rm -f /tmp/cap_*.$$
echo
if [ "$FAILED" -eq 0 ]; then echo "✅ STAFFING CAPACITY (migration 156) DB TESTS PASSED"
else echo "❌ STAFFING CAPACITY DB TESTS FAILED"; fi
exit "$FAILED"
