#!/usr/bin/env bash
# Local DB verification for migration 139 (approved hours).
#
# Boots a THROWAWAY Postgres 16 in Docker, applies the shared time-clock stub bootstrap + the REAL
# repo migrations that build `shifts` and the time clock (044/047/052/055/070/071/072), then
# applies the REAL 139 file verbatim and runs the assertions. Requires Docker only.
#
#   usage:  supabase/tests/approved_hours/run.sh
#   exit:   0 = all passed, 1 = something failed
#
# NEVER points at a hosted database. No host, URL or credential input; nothing here reads .env.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TC="$SCRIPT_DIR/../timeclock"
MIGDIR="$SCRIPT_DIR/../../migrations"
MIG139="$MIGDIR/139_shift_approved_minutes.sql"
CONTAINER="lensed_approved_test_$$"
IMAGE="postgres:16-alpine"
FAILED=0

cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psqlf(){ docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 "$@"; }
psqlq(){ docker exec -i "$CONTAINER" psql -U postgres -d db -tA "$@"; }

[ -f "$MIG139" ] || { echo "✗ migration not found: $MIG139"; exit 1; }

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
docker exec "$CONTAINER" createdb -U postgres db >/dev/null

echo "── bootstrap (stubs, shared with the timeclock harness) ──"
psqlf < "$TC/bootstrap.sql" >/dev/null || FAILED=1

# 091 (badge kiosk) is deliberately NOT applied: it needs the badge/clock-code world, and the only
# thing it adds to `shifts` is punch_method, which 139 neither reads nor writes.
echo "── apply real migrations 044, 047, 052, 055, 070, 071, 072 (the pre-139 world) ──"
for m in 044_create_employees_and_shifts 047_create_recurring_shifts 052_shifts_open_shift \
         055_shifts_source_rule_id 070_time_clock_attendance 071_time_clock_rpcs \
         072_time_clock_robustness; do
  if psqlf -1 < "$MIGDIR/$m.sql" >/dev/null 2>&1; then echo "  ✓ $m"
  else echo "  ✗ $m FAILED to apply"; FAILED=1; fi
done
[ "$FAILED" -eq 0 ] || { echo "❌ base schema failed — aborting"; exit 1; }

# The pre-139 world must have exactly ONE confirm overload, taking one argument.
PRE=$(psqlq -c "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_confirm_time_clock_shift'")
[ "$PRE" = "lensed_confirm_time_clock_shift(uuid)" ] && echo "  ✓ pre-139 confirm signature: $PRE" \
  || { echo "  ✗ unexpected pre-139 signature: $PRE"; FAILED=1; }
# Fingerprint the legacy body now, so the additive check below can prove 139 left it alone.
LEGACY_PRE=$(psqlq -c "select md5(pg_get_functiondef('public.lensed_confirm_time_clock_shift(uuid)'::regprocedure))")

echo "── apply migration 139 VERBATIM (it carries its own begin/commit) ──"
APPLY_LOG=/tmp/ah_apply.$$
if docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 < "$MIG139" >"$APPLY_LOG" 2>&1; then
  echo "  ✓ applied — ended with $(tail -1 "$APPLY_LOG")"
else
  echo "  ✗ MIGRATION FAILED TO APPLY:"; sed 's/^/    /' "$APPLY_LOG"; FAILED=1
fi
[ "$FAILED" -eq 0 ] || { echo "❌ migration did not apply — aborting"; exit 1; }

echo "── catalog ──"
COL=$(psqlq -c "select data_type||' null='||is_nullable||' def='||coalesce(column_default,'-') from information_schema.columns where table_schema='public' and table_name='shifts' and column_name='approved_minutes'")
[ "$COL" = "integer null=YES def=-" ] && echo "  ✓ approved_minutes: $COL (nullable, no default → catalog-only add)" \
  || { echo "  ✗ unexpected column shape: $COL"; FAILED=1; }
CK=$(psqlq -c "select pg_get_constraintdef(oid) from pg_constraint where conname='shifts_approved_minutes_range'")
case "$CK" in *"approved_minutes >= 0"*|*"approved_minutes IS NULL"*) echo "  ✓ range CHECK present: $CK";;
  *) echo "  ✗ range CHECK missing/odd: $CK"; FAILED=1;; esac
VALID=$(psqlq -c "select convalidated from pg_constraint where conname='shifts_approved_minutes_range'")
[ "$VALID" = "t" ] && echo "  ✓ CHECK is VALIDATED (not left NOT VALID)" || { echo "  ✗ CHECK not validated"; FAILED=1; }

# ── THE ADDITIVE-ROLLOUT PROPERTY ─────────────────────────────────────────────────────────────
# BOTH overloads must exist after 139: the legacy one-argument function so the app deployed before
# Approved Hours keeps confirming during the rollout, and the new two-argument one for the new app.
OVERLOADS=$(psqlq -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_confirm_time_clock_shift'")
SIGS=$(psqlq -c "select string_agg(p.oid::regprocedure::text, ' + ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_confirm_time_clock_shift'")
[ "$OVERLOADS" = "2" ] && echo "  ✓ BOTH confirm overloads present (additive: legacy kept)" \
  || { echo "  ✗ $OVERLOADS confirm overloads present (expected 2: legacy + new)"; FAILED=1; }
[ "$SIGS" = "lensed_confirm_time_clock_shift(uuid) + lensed_confirm_time_clock_shift(uuid,integer)" ] \
  && echo "  ✓ signatures: $SIGS" || { echo "  ✗ unexpected signatures: $SIGS"; FAILED=1; }

# The new argument must have NO DEFAULT. With a default, a one-argument call matches BOTH functions
# and Postgres raises "function is not unique" — breaking every confirm call in the deployed app.
# This is the single most important assertion in this file.
DEFAULTS=$(psqlq -c "select pronargdefaults from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lensed_confirm_time_clock_shift' and pronargs=2")
[ "$DEFAULTS" = "0" ] && echo "  ✓ the two-argument overload has NO defaulted parameters (no ambiguity)" \
  || { echo "  ✗ the two-argument overload has $DEFAULTS default(s) — a 1-arg call is now AMBIGUOUS"; FAILED=1; }

# And prove resolution empirically, from both call shapes, against a bogus id under a real identity.
# The two bodies are distinguishable by their return: only the NEW one reports approved_minutes.
probe(){ docker exec -i "$CONTAINER" psql -U postgres -d db -tA -c \
  "set \"test.user_id\" = 'a0000000-0000-4000-8000-0000000000ff'; $1" 2>&1 || true; }
ONEARG=$(probe "select public.lensed_confirm_time_clock_shift('00000000-0000-4000-8000-000000000000'::uuid);")
case "$ONEARG" in
  *"is not unique"*) echo "  ✗ AMBIGUOUS: a one-argument call matches both overloads"; FAILED=1;;
  *SHIFT_NOT_FOUND*) echo "  ✓ one-argument call resolves (legacy body reached: SHIFT_NOT_FOUND)";;
  *) echo "  ✗ the one-argument call shape broke: $ONEARG"; FAILED=1;;
esac
TWOARG=$(probe "select public.lensed_confirm_time_clock_shift('00000000-0000-4000-8000-000000000000'::uuid, 478);")
case "$TWOARG" in
  *"is not unique"*) echo "  ✗ AMBIGUOUS: a two-argument call matches both overloads"; FAILED=1;;
  *SHIFT_NOT_FOUND*) echo "  ✓ two-argument call resolves (new body reached: SHIFT_NOT_FOUND)";;
  *) echo "  ✗ the two-argument call shape broke: $TWOARG"; FAILED=1;;
esac
# The legacy body must be UNCHANGED by 139 — byte-identical to what migration 071 created.
LEGACY_071=$(docker exec -i "$CONTAINER" psql -U postgres -d db -tA -c "select md5(pg_get_functiondef('public.lensed_confirm_time_clock_shift(uuid)'::regprocedure))")
[ "$LEGACY_071" = "$LEGACY_PRE" ] && echo "  ✓ the legacy body is byte-identical before and after 139" \
  || { echo "  ✗ 139 CHANGED the legacy confirm body ($LEGACY_PRE -> $LEGACY_071)"; FAILED=1; }
# Transition markers, so the future cleanup has something to find.
COMMENTED=$(psqlq -c "select coalesce(obj_description('public.lensed_confirm_time_clock_shift(uuid)'::regprocedure, 'pg_proc'), '') like '%TRANSITION ONLY%'")
[ "$COMMENTED" = "t" ] && echo "  ✓ the legacy overload is marked TRANSITION ONLY" \
  || { echo "  ✗ the legacy overload carries no transition marker"; FAILED=1; }
# Grants: BOTH overloads must be callable by the manager session during the window.
for FN in 'public.lensed_confirm_time_clock_shift(uuid)' 'public.lensed_confirm_time_clock_shift(uuid,integer)'; do
  g=$(psqlq -c "select has_function_privilege('authenticated','$FN','execute')")
  [ "$g" = "t" ] && echo "  ✓ authenticated may call $FN" || { echo "  ✗ authenticated cannot call $FN"; FAILED=1; }
done

# ── AUTHORIZATION PROOF — a GRANT is not authorization ────────────────────────────────────────
# All three new functions must be SECURITY INVOKER, so RLS on `shifts` still applies as the caller
# and the function cannot become a privilege-escalation hole if a policy is ever relaxed.
for FN in 'public.lensed_confirm_time_clock_shift(uuid,integer)' \
          'public.lensed_unconfirm_time_clock_shift(uuid)' \
          'public.lensed_set_approved_minutes(uuid,integer)'; do
  d=$(psqlq -c "select prosecdef from pg_proc where oid = '$FN'::regprocedure")
  [ "$d" = "f" ] && echo "  ✓ SECURITY INVOKER: $FN" \
    || { echo "  ✗ $FN is SECURITY DEFINER — it would bypass RLS"; FAILED=1; }
done
# With NO identity (the anon path: `authenticated` and PUBLIC both hold EXECUTE), every mutation
# path must refuse before it looks at anything. This is the assertion that says out loud that the
# GRANT is not the authorization boundary.
noauth(){ docker exec -i "$CONTAINER" psql -U postgres -d db -tA -c \
  "set \"test.user_id\" = ''; $1" 2>&1 || true; }
for CALL in "public.lensed_confirm_time_clock_shift('00000000-0000-4000-8000-000000000000'::uuid, 60)" \
            "public.lensed_confirm_time_clock_shift('00000000-0000-4000-8000-000000000000'::uuid)" \
            "public.lensed_set_approved_minutes('00000000-0000-4000-8000-000000000000'::uuid, 60)" \
            "public.lensed_unconfirm_time_clock_shift('00000000-0000-4000-8000-000000000000'::uuid)"; do
  out=$(noauth "select $CALL;")
  case "$out" in
    *NOT_AUTHENTICATED*) echo "  ✓ refused with no identity: ${CALL%%(*}";;
    *) echo "  ✗ ${CALL%%(*} did NOT refuse an unauthenticated caller: $out"; FAILED=1;;
  esac
done

echo "── assertions ──"
psqlf < "$SCRIPT_DIR/test_approved.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //;s/^/  /' || FAILED=1

echo "── grants: authenticated (manager session), never service_role-only ──"
for FN in 'public.lensed_confirm_time_clock_shift(uuid,integer)' \
          'public.lensed_unconfirm_time_clock_shift(uuid)' \
          'public.lensed_set_approved_minutes(uuid,integer)'; do
  got=$(psqlq -c "select has_function_privilege('authenticated','$FN','execute')")
  [ "$got" = "t" ] && echo "  ✓ authenticated EXECUTE on $FN" || { echo "  ✗ authenticated lacks EXECUTE on $FN"; FAILED=1; }
done

echo "── idempotence: re-apply 139 on top of itself (with a live approval present) ──"
BEFORE=$(psqlq -c "select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lensed_confirm_time_clock_shift','lensed_unconfirm_time_clock_shift','lensed_set_approved_minutes','shifts_guard_confirmation')")
if docker exec -i "$CONTAINER" psql -U postgres -d db -v ON_ERROR_STOP=1 < "$MIG139" >/dev/null 2>&1; then
  AFTER=$(psqlq -c "select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lensed_confirm_time_clock_shift','lensed_unconfirm_time_clock_shift','lensed_set_approved_minutes','shifts_guard_confirmation')")
  [ "$BEFORE" = "$AFTER" ] && echo "  ✓ re-apply clean; the four function bodies are byte-identical" \
    || { echo "  ✗ function bodies DRIFTED on re-apply"; FAILED=1; }
  ROWS=$(psqlq -c "select count(*) from public.shifts where approved_minutes is not null")
  [ "$ROWS" != "0" ] && echo "  ✓ existing approvals survived the re-apply ($ROWS row(s))" \
    || { echo "  ✗ re-apply lost the approved values"; FAILED=1; }
else echo "  ✗ re-apply FAILED"; FAILED=1; fi

rm -f /tmp/ah_*.$$
echo
if [ "$FAILED" -eq 0 ]; then echo "✅ APPROVED HOURS (migration 139) DB TESTS PASSED"
else echo "❌ APPROVED HOURS DB TESTS FAILED"; fi
exit "$FAILED"
