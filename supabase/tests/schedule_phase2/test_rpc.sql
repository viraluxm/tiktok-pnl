-- lensed_approve_shift_pickup: happy path, replay, and every refusal path (migration 129, extended by 130).
--
-- The refusal assertions all go through t_refuse, which additionally proves the instance and its
-- claims were NOT mutated. A refusal that moved something is the torn state this RPC exists to
-- prevent — see test_atomicity.sql for the regression that guards the fix.
\set QUIET on
set client_min_messages = notice;
delete from public.shift_claims;
delete from public.shift_instances;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- HAPPY PATH — a real atomic transfer
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  carol uuid := 'e3333333-0000-4000-8000-000000000003';
  o1 uuid := gen_random_uuid();
  s uuid; cb uuid; cc uuid; res jsonb; inst public.shift_instances;
begin
  s  := mk(alice, '2026-12-01', 'scheduled', 'offered', o1, now());
  cb := mkc(s, bob,   'pending', 'pickup_request', o1);
  cc := mkc(s, carol, 'pending', 'pickup_request', o1);

  res := public.lensed_approve_shift_pickup(A, s, cb, o1, date '2026-09-07');
  perform t_eq('happy: ok=true',                     res->>'ok',                   'true');
  perform t_eq('happy: employee_id = winner (Bob)',  res->>'employee_id',          bob::text);
  perform t_eq('happy: previous_employee_id=Alice',  res->>'previous_employee_id', alice::text);
  perform t_eq('happy: offer_id echoed',             res->>'offer_id',             o1::text);
  perform t_eq('happy: superseded = 1 (Carol)',      res->>'superseded',           '1');

  select * into inst from public.shift_instances where id = s;
  perform t_eq('happy: instance employee_id -> Bob',     inst.employee_id, bob);
  perform t_eq('happy: instance status -> claimed',      inst.status,      'claimed');
  perform t_eq('happy: instance source -> claim',        inst.source,      'claim');
  perform t_eq('happy: released_at stays NULL',          inst.released_at, null::timestamptz);
  perform t_eq('happy: offer_state -> transferred',      inst.offer_state, 'transferred');
  perform t_eq('happy: offer_id RETAINED as history',    inst.offer_id,    o1);
  perform t_eq('happy: offered_at RETAINED',             (inst.offered_at is not null), true);
  -- The whole point of PR #217's invariant: the NEW owner must be able to clock in.
  perform t_eq('happy: new owner is clock-eligible',
    (inst.status in ('scheduled','claimed') and inst.released_at is null), true);

  perform t_eq('happy: winner claim approved',    (select status      from public.shift_claims where id=cb), 'approved');
  perform t_eq('happy: winner approved_by=owner', (select approved_by from public.shift_claims where id=cb), A);
  -- 'superseded', never 'rejected' — the worker sees the difference and "wasn't approved" is a lie
  -- for someone who simply lost a race.
  perform t_eq('happy: rival claim superseded',   (select status      from public.shift_claims where id=cc), 'superseded');

  -- ═══ REPLAY: approving twice must not double-write ═══
  res := public.lensed_approve_shift_pickup(A, s, cb, o1, date '2026-09-07');
  perform t_eq('replay: second approve refuses',  res->>'ok',     'false');
  perform t_eq('replay: reason ALREADY_APPROVED', res->>'reason', 'ALREADY_APPROVED');
  perform t_eq('replay: no double-write (still Bob)',
    (select employee_id from public.shift_instances where id=s), bob);
  perform t_eq('replay: superseded rival untouched',
    (select status from public.shift_claims where id=cc), 'superseded');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- REFUSAL PATHS — each must return ok:false AND leave every row untouched
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  A uuid := 'a0000000-0000-4000-8000-000000000001';
  B uuid := 'b0000000-0000-4000-8000-000000000002';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  carol uuid := 'e3333333-0000-4000-8000-000000000003';
  dave  uuid := 'e4444444-0000-4000-8000-000000000004';  -- status 'former'
  o1 uuid; o2 uuid; s uuid; c uuid; res jsonb;
begin
  -- A null owner is a CALLER FAULT, not a business refusal, so it raises rather than returning.
  begin
    res := public.lensed_approve_shift_pickup(null, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), date '2026-09-07');
    perform t_eq('null owner: should have raised', 'no raise', 'INVALID_OWNER');
  exception when others then
    perform t_eq('null owner RAISES INVALID_OWNER', SQLERRM, 'INVALID_OWNER');
  end;

  o1 := gen_random_uuid();
  s  := mk(alice,'2027-01-05','scheduled','offered',o1,now());
  c  := mkc(s, bob, 'pending','pickup_request', o1);

  perform t_refuse('claim: unknown claim id',      A, s, gen_random_uuid(), o1, 'CLAIM_NOT_FOUND');
  -- TENANCY: owner B must not be able to approve owner A's pickup.
  perform t_refuse('claim: WRONG OWNER (tenancy)', B, s, c, o1, 'CLAIM_NOT_FOUND');
  perform t_refuse('claim: wrong shift for claim', A, gen_random_uuid(), c, o1, 'CLAIM_NOT_FOUND');
  perform t_refuse('claim: wrong offer cycle on the claim', A, s, c, gen_random_uuid(), 'CLAIM_NOT_FOUND');

  declare c_ot uuid := mkc(s, carol, 'pending', 'ot_claim', null);
  begin
    -- An OT claim must never be approvable through the PICKUP rpc.
    perform t_refuse('claim: ot_claim is not approvable here', A, s, c_ot, o1, 'CLAIM_NOT_FOUND');
  end;

  declare c2 uuid := mkc(s, carol, 'rejected', 'pickup_request', o1);
  begin
    perform t_refuse('claim: already rejected -> CLAIM_NOT_PENDING', A, s, c2, o1, 'CLAIM_NOT_PENDING');
  end;

  update public.shift_instances set offer_state='closed' where id=s;
  perform t_refuse('offer: closed -> OFFER_NOT_OPEN', A, s, c, o1, 'OFFER_NOT_OPEN');
  update public.shift_instances set offer_state='transferred' where id=s;
  perform t_refuse('offer: transferred -> OFFER_NOT_OPEN', A, s, c, o1, 'OFFER_NOT_OPEN');
  update public.shift_instances set offer_state=null, offer_id=null, offered_at=null where id=s;
  perform t_refuse('offer: never offered -> OFFER_NOT_OPEN', A, s, c, o1, 'OFFER_NOT_OPEN');

  -- ═══ THE ABA GUARD ═══
  -- Re-offer under a NEW generation while an OLD-cycle request is still pending. The stale request
  -- must not be able to transfer the shift.
  o2 := gen_random_uuid();
  update public.shift_instances set offer_state='offered', offer_id=o2, offered_at=now() where id=s;
  perform t_refuse('ABA: stale-cycle claim cannot transfer a RE-OFFERED shift', A, s, c, o1, 'STALE_OFFER');
  perform t_eq('ABA: shift still owned by Alice',
    (select employee_id from public.shift_instances where id=s), alice);
  perform t_eq('ABA: stale claim still pending',
    (select status from public.shift_claims where id=c), 'pending');

  declare s2 uuid; c3 uuid; o3 uuid := gen_random_uuid();
  begin
    s2 := mk(bob,'2027-01-06','scheduled','offered',o3,now());
    c3 := mkc(s2, bob, 'pending','pickup_request', o3);   -- Bob requests his OWN shift
    perform t_refuse('assign: requester already owns it -> ALREADY_ASSIGNED', A, s2, c3, o3, 'ALREADY_ASSIGNED');
  end;

  declare s3 uuid; c4 uuid; o4 uuid := gen_random_uuid();
  begin
    s3 := mk(alice,'2027-01-07','scheduled','offered',o4,now());
    c4 := mkc(s3, dave, 'pending','pickup_request', o4);  -- Dave is 'former'
    perform t_refuse('employee: former employee -> EMPLOYEE_UNAVAILABLE', A, s3, c4, o4, 'EMPLOYEE_UNAVAILABLE');
  end;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A PENDING REQUESTER IS NOT SCHEDULE-BOUND CLOCK-ELIGIBLE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Asking for a shift must grant NOTHING until a manager approves. The QR/kiosk clock path resolves
-- an instance by id and requires (employee_id = the puncher, status in CLOCK_ELIGIBLE_STATUSES,
-- released_at IS NULL) — so the test that matters is that a pending pickup leaves employee_id on
-- the OFFERER. Elsewhere we prove the offerer keeps eligibility and the winner gains it; this pins
-- the third case, that the loser/pending requester never had it.
do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';  -- offerer
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';  -- requester
  o uuid := gen_random_uuid();
  s uuid; c uuid; inst public.shift_instances;
begin
  s := mk(alice, '2027-02-14', 'scheduled', 'offered', o, now());
  c := mkc(s, bob, 'pending', 'pickup_request', o);   -- request filed, nothing approved

  select * into inst from public.shift_instances where id = s;
  perform t_eq('pending: instance still assigned to the OFFERER', inst.employee_id, alice);
  perform t_eq('pending: requester holds NO assignment on it', inst.employee_id = bob, false);
  -- The clock predicate, spelled out exactly as the three gates apply it.
  perform t_eq('pending: requester is NOT clock-eligible for this shift',
    (inst.employee_id = bob and inst.status in ('scheduled','claimed') and inst.released_at is null), false);
  perform t_eq('pending: OFFERER is still clock-eligible for it',
    (inst.employee_id = alice and inst.status in ('scheduled','claimed') and inst.released_at is null), true);
  perform t_eq('pending: the request itself is the only new row', 
    (select status from public.shift_claims where id = c), 'pending');

  -- ...and after approval the eligibility flips exactly once, in the same direction.
  perform public.lensed_approve_shift_pickup(A, s, c, o, date '2026-09-07');
  select * into inst from public.shift_instances where id = s;
  perform t_eq('approved: requester IS now clock-eligible',
    (inst.employee_id = bob and inst.status in ('scheduled','claimed') and inst.released_at is null), true);
  perform t_eq('approved: former owner is NO LONGER eligible', inst.employee_id = alice, false);
end $$;

select t_report('RPC happy path, replay, and refusal paths');
