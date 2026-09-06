#!/usr/bin/env bash
# Local DB verification for scheduling Phase 2 (migration 129 — offer lifecycle).
#
# Boots a THROWAWAY Postgres 16 in Docker, applies the base stub + the REAL repo migrations that
# build shift_instances/shift_claims (044/047/085/086/090), then applies the REAL 129 file
# verbatim and runs the behavioural assertions against it. Requires Docker only (psql runs inside
# the container). No host psql needed. Mirrors ../timeclock/run.sh and ../batch_edit_delete/run.sh.
#
#   usage:  supabase/tests/schedule_phase2/run.sh
#   exit:   0 = all passed, 1 = something failed
#
# NEVER points at a hosted database. The connection is always the local container; there is no
# host, URL or credential input of any kind, and nothing here reads .env.
#
# What is covered:
#   • the migration parses and COMMITs as its own transaction
#   • catalog: every column/CHECK/index/function 129 claims to create
#   • runtime constraint behaviour (which rows are accepted vs rejected, and BY WHICH rule)
#   • the partial UNIQUE indexes (one winner per shift; one pending request per claimer)
#   • RPC happy path — a real atomic transfer — plus replay and every refusal path
#   • the ABA / stale-offer guard
#   • atomicity: a post-assignment failure rolls the whole transfer back (torn-state regression)
#   • two-session concurrency: rival approvals serialize on the per-shift advisory lock
#   • grants: service_role only; PUBLIC/anon/authenticated must NOT have EXECUTE
#   • idempotence: re-applying 129 leaves the catalog byte-identical
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGDIR="$SCRIPT_DIR/../../migrations"
MIG129="$MIGDIR/129_schedule_phase2_offer_lifecycle.sql"
CONTAINER="lensed_phase2_test_$$"
IMAGE="postgres:16-alpine"
DB="db"
OWNER_A="a0000000-0000-4000-8000-000000000001"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
psqlq(){ docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA "$@"; }

[ -f "$MIG129" ] || { echo "✗ migration not found: $MIG129"; exit 1; }

echo "▶ starting $IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || {
  echo "✗ could not start the container — is the Docker daemon running?"; exit 1; }
echo -n "▶ waiting for postgres"
# The alpine image runs a temporary init server (which answers briefly) before the real one, so
# require several CONSECUTIVE successful queries to be sure the real server is stably up.
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

echo "── bootstrap (stubs) ──"
psqlf -q < "$SCRIPT_DIR/bootstrap.sql" >/dev/null || FAILED=1

echo "── apply real migrations 044, 047, 085, 086, 090 (the pre-129 world) ──"
for m in 044_create_employees_and_shifts 047_create_recurring_shifts \
         085_scheduling_v1_schema 086_collapse_shift_templates 090_shift_instances_admin_open; do
  if psqlf -q -1 < "$MIGDIR/$m.sql" >/dev/null 2>&1; then echo "  ✓ $m"
  else echo "  ✗ $m FAILED to apply"; FAILED=1; fi
done
[ "$FAILED" -eq 0 ] || { echo "❌ base schema failed — aborting"; exit 1; }

# Catalog snapshot BEFORE, so the diff proves 129 is purely additive.
CATALOG_SQL="$SCRIPT_DIR/catalog.sql"
psqlf -q -f - < "$CATALOG_SQL" > /tmp/p2_before.$$ 2>&1

echo "── apply migration 129 VERBATIM (no -1: the file carries its own begin/commit) ──"
APPLY_LOG=/tmp/p2_apply.$$
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG129" >"$APPLY_LOG" 2>&1; then
  echo "  ✓ applied — $(grep -c '^NOTICE' "$APPLY_LOG" || true) notices, ended with $(tail -1 "$APPLY_LOG")"
else
  echo "  ✗ MIGRATION FAILED TO APPLY:"; sed 's/^/    /' "$APPLY_LOG"; FAILED=1
fi
[ "$FAILED" -eq 0 ] || { echo "❌ migration did not apply — aborting"; exit 1; }

echo "── catalog: 129 must be purely ADDITIVE ──"
psqlf -q -f - < "$CATALOG_SQL" > /tmp/p2_after.$$ 2>&1
# The ONLY acceptable removal is the shift_claims status CHECK, replaced by a strict superset.
REMOVED=$(diff /tmp/p2_before.$$ /tmp/p2_after.$$ | grep '^<' | grep -v 'shift_claims_status_check' || true)
if [ -z "$REMOVED" ]; then echo "  ✓ nothing dropped or narrowed (status CHECK widened only)"
else echo "  ✗ UNEXPECTED REMOVALS:"; echo "$REMOVED" | sed 's/^/    /'; FAILED=1; fi
for want in 'COL shift_instances.offer_state' 'COL shift_instances.offer_id' 'COL shift_instances.offered_at' \
            'COL shift_claims.kind' 'COL shift_claims.offer_id' \
            'shift_instances_offer_state_check' 'shift_instances_offer_triple_consistent' \
            'shift_instances_offered_is_owned' 'shift_claims_kind_check' 'shift_claims_pickup_has_offer' \
            'shift_claims_pickup_never_auto' 'superseded' \
            'idx_shift_claims_one_approved_pickup' 'idx_shift_claims_one_pending_pickup_per_employee' \
            'idx_shift_claims_pending_pickup' 'idx_shift_instances_offered' \
            'lensed_approve_shift_pickup(uuid,uuid,uuid,uuid) sec=definer cfg=search_path=public'; do
  grep -qF "$want" /tmp/p2_after.$$ || { echo "  ✗ MISSING from catalog: $want"; FAILED=1; }
done
echo "  ✓ all expected objects present"

echo "── helpers + seed ──"
psqlf -q < "$SCRIPT_DIR/harness.sql" >/dev/null || FAILED=1
psqlf -q < "$SCRIPT_DIR/seed.sql"    >/dev/null || FAILED=1

echo
echo "── shift_instances offer constraints ──"
psqlf -q < "$SCRIPT_DIR/test_constraints.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── shift_claims constraints + partial unique indexes ──"
psqlf -q < "$SCRIPT_DIR/test_claims.sql"      2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── RPC: happy path, replay, refusal paths ──"
psqlf -q < "$SCRIPT_DIR/test_rpc.sql"         2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1
echo "── atomicity / torn-state regression ──"
psqlf -q < "$SCRIPT_DIR/test_atomicity.sql"   2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1

# ── GRANTS ─────────────────────────────────────────────────────────────────────────────────────
# 129 revokes from public/anon/authenticated and grants ONLY service_role. A stray grant here
# would let any signed-in user transfer another tenant's shift, since the RPC takes p_owner as a
# parameter and cannot consult auth.uid().
echo "── grants: service_role ONLY ──"
FN='public.lensed_approve_shift_pickup(uuid,uuid,uuid,uuid)'
for role in service_role authenticated anon public; do
  got=$(psqlq -c "select has_function_privilege('$role','$FN','execute')")
  want=$([ "$role" = "service_role" ] && echo t || echo f)
  if [ "$got" = "$want" ]; then echo "  ✓ $role EXECUTE = $got"
  else echo "  ✗ $role EXECUTE = $got (expected $want)"; FAILED=1; fi
done
# Live enforcement, not just the catalog bit.
for role in authenticated anon; do
  out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
        "set role $role; select public.lensed_approve_shift_pickup('$OWNER_A'::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid());" 2>&1 || true)
  case "$out" in *"permission denied for function"*) echo "  ✓ SET ROLE $role → permission denied";;
                 *) echo "  ✗ SET ROLE $role was NOT blocked: $out"; FAILED=1;; esac
done
# SECURITY DEFINER really is load-bearing: service_role has no table privileges here, yet the call
# reaches business logic (a clean refusal) rather than a permission error.
out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
      "set role service_role; select public.lensed_approve_shift_pickup('$OWNER_A'::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid());" 2>&1 || true)
case "$out" in *CLAIM_NOT_FOUND*) echo "  ✓ SET ROLE service_role → executes under SECURITY DEFINER";;
               *) echo "  ✗ service_role call failed: $out"; FAILED=1;; esac

# ── CONCURRENCY ────────────────────────────────────────────────────────────────────────────────
# Two managers approve RIVAL pickups on the same shift at the same time. pg_advisory_xact_lock
# must serialize them: exactly one winner, and the loser gets a clean refusal — never two
# approvals, never an assignment that disagrees with the approved claim.
echo "── concurrency: rival approvals serialize on the per-shift advisory lock ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.shift_claims; delete from public.shift_instances;
create table if not exists race_ids(k text primary key, v uuid);
truncate race_ids;
with o as (select gen_random_uuid() oid),
     s as (insert into public.shift_instances(user_id,employee_id,shift_date,starts_at,ends_at,status,offer_state,offer_id,offered_at)
           select '$OWNER_A','e1111111-0000-4000-8000-000000000001','2027-05-01',
                  '2027-05-01 09:00Z','2027-05-01 17:00Z','scheduled','offered',oid,now() from o returning id, offer_id),
     cb as (insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status,kind,offer_id)
            select '$OWNER_A',id,'e2222222-0000-4000-8000-000000000002','pending','pickup_request',offer_id from s returning id),
     cc as (insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status,kind,offer_id)
            select '$OWNER_A',id,'e3333333-0000-4000-8000-000000000003','pending','pickup_request',offer_id from s returning id)
insert into race_ids(k,v) select 'shift',id from s union all select 'offer',offer_id from s
  union all select 'cb',id from cb union all select 'cc',id from cc;
SQL

race_session(){ # $1 = claim key
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<SQL
begin;
select '$1 -> '||public.lensed_approve_shift_pickup('$OWNER_A'::uuid,
  (select v from race_ids where k='shift'), (select v from race_ids where k='$1'),
  (select v from race_ids where k='offer'))::text;
select pg_sleep(1.5);
commit;
SQL
}
race_session cb > /tmp/p2_cb.$$ 2>&1 & P1=$!
sleep 1                      # let session CB take the advisory lock first
race_session cc > /tmp/p2_cc.$$ 2>&1 & P2=$!
wait "$P1" "$P2" 2>/dev/null || true
grep -hE '^(cb|cc) ->' /tmp/p2_cb.$$ /tmp/p2_cc.$$ | sed 's/^/    /'
WINNERS=$(psqlq -c "select count(*) from public.shift_claims where shift_instance_id=(select v from race_ids where k='shift') and kind='pickup_request' and status in ('approved','auto_approved')")
AGREES=$(psqlq -c "select (select employee_id from public.shift_instances where id=(select v from race_ids where k='shift')) = (select claimed_by from public.shift_claims where shift_instance_id=(select v from race_ids where k='shift') and kind='pickup_request' and status='approved')")
LEFTOVER=$(psqlq -c "select count(*) from public.shift_claims where shift_instance_id=(select v from race_ids where k='shift') and status='pending'")
[ "$WINNERS"  = "1" ] && echo "  ✓ exactly one approved pickup"            || { echo "  ✗ approved pickups = $WINNERS (expected 1)"; FAILED=1; }
[ "$AGREES"   = "t" ] && echo "  ✓ assignment agrees with the approved claim" || { echo "  ✗ assignment disagrees with the approved claim"; FAILED=1; }
[ "$LEFTOVER" = "0" ] && echo "  ✓ no pending requests left in the cycle"   || { echo "  ✗ $LEFTOVER pending left"; FAILED=1; }

# ── OUT-OF-TRANSACTION ROLLBACK ────────────────────────────────────────────────────────────────
# The true PostgREST shape: an autocommit call whose error aborts the implicit transaction. A
# BRAND-NEW connection must then see the shift completely unmoved.
echo "── rollback in the real PostgREST shape (autocommit + fresh connection) ──"
psqlf -q >/dev/null 2>&1 <<SQL || FAILED=1
delete from public.shift_claims; delete from public.shift_instances; truncate race_ids;
with s as (insert into public.shift_instances(user_id,employee_id,shift_date,starts_at,ends_at,status,offer_state,offer_id,offered_at)
           values ('$OWNER_A','e1111111-0000-4000-8000-000000000001','2027-06-01',
                   '2027-06-01 09:00Z','2027-06-01 17:00Z','scheduled','offered',gen_random_uuid(),now()) returning id, offer_id),
     c0 as (insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status,kind,offer_id)
            select '$OWNER_A',id,'e3333333-0000-4000-8000-000000000003','approved','pickup_request',gen_random_uuid() from s returning id),
     cb as (insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status,kind,offer_id)
            select '$OWNER_A',id,'e2222222-0000-4000-8000-000000000002','pending','pickup_request',offer_id from s returning id)
insert into race_ids(k,v) select 'shift',id from s union all select 'offer',offer_id from s union all select 'cb',id from cb;
SQL
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -c \
  "select public.lensed_approve_shift_pickup('$OWNER_A'::uuid,(select v from race_ids where k='shift'),(select v from race_ids where k='cb'),(select v from race_ids where k='offer'))::text;" >/tmp/p2_tear.$$ 2>&1
grep -q 'idx_shift_claims_one_approved_pickup' /tmp/p2_tear.$$ \
  && echo "  ✓ post-assignment unique_violation raised (not swallowed)" \
  || { echo "  ✗ expected an uncaught unique_violation; got: $(cat /tmp/p2_tear.$$)"; FAILED=1; }
STILL=$(psqlq -c "select employee_id||'|'||status||'|'||offer_state from public.shift_instances where id=(select v from race_ids where k='shift')")
PEND=$(psqlq -c "select status from public.shift_claims where id=(select v from race_ids where k='cb')")
[ "$STILL" = "e1111111-0000-4000-8000-000000000001|scheduled|offered" ] \
  && echo "  ✓ fresh connection sees the transfer fully rolled back" \
  || { echo "  ✗ TORN STATE: $STILL"; FAILED=1; }
[ "$PEND" = "pending" ] && echo "  ✓ winner claim still pending" || { echo "  ✗ claim is '$PEND'"; FAILED=1; }

# ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────
# Re-applying is a REAL risk: this database has no migration ledger, so a duplicate hand-apply is
# a live hazard rather than a hypothetical. Re-apply on top of LIVE offered rows.
echo "── idempotence: re-apply 129 on top of itself (with live offers present) ──"
psqlf -q >/dev/null 2>&1 <<SQL
update public.shift_instances set offer_state='offered', offer_id=gen_random_uuid(), offered_at=now()
 where id=(select v from race_ids where k='shift');
SQL
if docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 < "$MIG129" >/dev/null 2>&1; then
  psqlf -q -f - < "$CATALOG_SQL" > /tmp/p2_after2.$$ 2>&1
  if diff -q /tmp/p2_after.$$ /tmp/p2_after2.$$ >/dev/null; then echo "  ✓ re-apply clean; catalog byte-identical"
  else echo "  ✗ catalog DRIFTED on re-apply:"; diff /tmp/p2_after.$$ /tmp/p2_after2.$$ | sed 's/^/    /'; FAILED=1; fi
else echo "  ✗ re-apply FAILED"; FAILED=1; fi

rm -f /tmp/p2_*.$$
echo
if [ "$FAILED" -eq 0 ]; then echo "✅ SCHEDULE PHASE 2 (migration 129) DB TESTS PASSED"
else echo "❌ SCHEDULE PHASE 2 DB TESTS FAILED"; fi
exit "$FAILED"
