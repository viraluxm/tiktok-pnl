-- shift_claims pickup constraints + the two partial UNIQUE indexes (migration 129, section 2).
--
-- Phase 2 pickup requests SHARE this table with the legacy OT-claim flow. Every assertion below
-- exists to prove the two kinds stay separated: the legacy flow must be provably untouched.
\set QUIET on
set client_min_messages = notice;
delete from public.shift_claims;
delete from public.shift_instances;

do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  carol uuid := 'e3333333-0000-4000-8000-000000000003';
  o1 uuid := gen_random_uuid();
  o2 uuid := gen_random_uuid();
  s1 uuid; s2 uuid;
begin
  s1 := mk(alice, '2026-11-02', 'scheduled', 'offered', o1, now());
  s2 := mk(alice, '2026-11-03', 'scheduled', 'offered', o2, now());

  -- ═══ THE `kind` DEFAULT MUST BACK-FILL LEGACY WRITES ═══
  -- claim.ts inserts without naming `kind`. If the default were missing this breaks in production
  -- the first time anyone claims an OT shift.
  perform t_accept('default: legacy-shaped insert (no kind/offer_id) works',
    format('insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status)
            values (%L,%L,%L,''pending'')', A, s1, carol));
  perform t_eq('default: that row got kind=ot_claim',
    (select kind from public.shift_claims where shift_instance_id=s1 and claimed_by=carol), 'ot_claim');

  -- ═══ kind VOCABULARY ═══
  perform t_reject('kind: ''bogus'' rejected',
    format('select mkc(%L,%L,''pending'',''bogus'',%L)', s1, bob, o1), 'shift_claims_kind_check');
  perform t_reject('kind: NULL rejected (NOT NULL)',
    format('insert into public.shift_claims(user_id,shift_instance_id,claimed_by,status,kind)
            values (%L,%L,%L,''pending'',null)', A, s1, bob),
    'null value in column "kind"');

  -- ═══ status VOCABULARY — WIDENED, never narrowed ═══
  -- All four legacy values must survive; only 'superseded' is added.
  perform t_accept('status: legacy auto_approved still valid (ot_claim)',
    format('select mkc(%L,%L,''auto_approved'')', s2, carol));
  perform t_accept('status: legacy rejected still valid (ot_claim)',
    format('select mkc(%L,%L,''rejected'')', s2, bob));
  perform t_accept('status: NEW superseded is valid',
    format('select mkc(%L,%L,''superseded'',''pickup_request'',%L)', s2, alice, o2));
  perform t_reject('status: ''bogus'' still rejected',
    format('select mkc(%L,%L,''bogus'')', s2, alice), 'shift_claims_status_check');

  -- ═══ pickup_has_offer — BIDIRECTIONAL ═══
  -- A pickup without a cycle could never be ABA-guarded; an ot_claim WITH one would be picked up
  -- by the pickup queries.
  perform t_reject('offer: pickup_request WITHOUT offer_id',
    format('select mkc(%L,%L,''pending'',''pickup_request'',null)', s1, bob),
    'shift_claims_pickup_has_offer');
  perform t_reject('offer: ot_claim WITH an offer_id',
    format('select mkc(%L,%L,''pending'',''ot_claim'',%L)', s1, bob, o1),
    'shift_claims_pickup_has_offer');
  perform t_accept('offer: pickup_request WITH offer_id',
    format('select mkc(%L,%L,''pending'',''pickup_request'',%L)', s1, bob, o1));

  -- ═══ pickup_never_auto ═══
  -- Phase 2's product rule is that a MANAGER decides every transfer. This is the enforcement that
  -- survives a future code change re-routing claimShift's auto-approve branch.
  perform t_reject('never-auto: pickup_request + auto_approved',
    format('select mkc(%L,%L,''auto_approved'',''pickup_request'',%L)', s1, alice, o1),
    'shift_claims_pickup_never_auto');
  perform t_reject('never-auto: UPDATE a pending pickup to auto_approved',
    format('update public.shift_claims set status=''auto_approved''
            where shift_instance_id=%L and claimed_by=%L and kind=''pickup_request''', s1, bob),
    'shift_claims_pickup_never_auto');

  -- ═══ INDEX B: one PENDING pickup per (shift, employee) ═══
  perform t_reject('index B: same employee, same shift, second pending pickup',
    format('select mkc(%L,%L,''pending'',''pickup_request'',%L)', s1, bob, o1),
    'idx_shift_claims_one_pending_pickup_per_employee');
  -- DOCUMENTED BEHAVIOUR, NOT A BUG (yet): index B is keyed on the SHIFT, not the offer cycle, so
  -- it also blocks a request under a NEW cycle while an OLD-cycle request is still pending. Today
  -- that is unreachable — nothing re-offers a shift with pending requests left behind. It becomes
  -- reachable the moment Cancel Offer ships, which must supersede the old cycle's pendings.
  perform t_reject('index B: fires across cycles too (trap: Cancel Offer must supersede)',
    format('select mkc(%L,%L,''pending'',''pickup_request'',%L)', s1, bob, o2),
    'idx_shift_claims_one_pending_pickup_per_employee');
  perform t_accept('index B: a DIFFERENT employee may also request the same shift',
    format('select mkc(%L,%L,''pending'',''pickup_request'',%L)', s1, carol, o1));
  perform t_accept('index B: does NOT constrain ot_claim duplicates',
    format('select mkc(%L,%L,''pending'')', s1, bob));
  perform t_accept('index B: same employee may re-request once the old row leaves pending',
    format('with moved as (update public.shift_claims set status=''superseded''
              where shift_instance_id=%L and claimed_by=%L and kind=''pickup_request'' and status=''pending''
              returning 1)
            select (select count(*) from moved), mkc(%L,%L,''pending'',''pickup_request'',%L)',
            s1, bob, s1, bob, o2));

  -- ═══ INDEX A: one APPROVED pickup per shift ═══
  -- This is what makes "only one winner" a DATABASE guarantee rather than an accident of ordering.
  perform t_accept('index A: first approved pickup on the shift',
    format('update public.shift_claims set status=''approved''
            where shift_instance_id=%L and claimed_by=%L and kind=''pickup_request'' and status=''pending''',
            s1, carol));
  perform t_reject('index A: a SECOND approved pickup on the same shift',
    format('update public.shift_claims set status=''approved''
            where shift_instance_id=%L and claimed_by=%L and kind=''pickup_request'' and status=''pending''',
            s1, bob),
    'idx_shift_claims_one_approved_pickup');
  perform t_reject('index A: even a DIFFERENT-cycle pickup cannot be the 2nd winner',
    format('select mkc(%L,%L,''approved'',''pickup_request'',%L)', s1, alice, gen_random_uuid()),
    'idx_shift_claims_one_approved_pickup');
  perform t_accept('index A: does NOT constrain approved ot_claims',
    format('select mkc(%L,%L,''approved'')', s1, alice));
  perform t_accept('index A: does NOT constrain approved pickups on a DIFFERENT shift',
    format('select mkc(%L,%L,''approved'',''pickup_request'',%L)', s2, carol, o2));
end $$;

select t_report('shift_claims constraints + partial unique indexes');
