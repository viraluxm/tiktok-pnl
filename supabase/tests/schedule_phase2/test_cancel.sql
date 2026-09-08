-- CANCEL OFFER + RE-OFFER lifecycle (migration 130).
--
-- Cancelling is the employee taking their own offer back. The shift never stopped being theirs, so
-- the assertions below are as much about what must NOT change (assignment, status, released_at,
-- attendance, payroll) as about what must.
--
-- The re-offer section closes the known trap: idx_shift_claims_one_pending_pickup_per_employee is
-- keyed on the SHIFT, not the offer cycle, so a stale pending request from a dead cycle would
-- permanently block that coworker from asking again. Cancel superseding its cycle is what prevents
-- that, and the tests prove it end to end.
\set QUIET on
set client_min_messages = notice;
delete from public.attendance_events;
delete from public.shift_claims;
delete from public.shift_instances;

do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  B     uuid := 'b0000000-0000-4000-8000-000000000002';   -- foreign tenant
  alice uuid := 'e1111111-0000-4000-8000-000000000001';   -- the offerer (Carlos)
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';   -- requester (Juan)
  carol uuid := 'e3333333-0000-4000-8000-000000000003';   -- rival requester
  pp date := date '2026-09-07';
  oA uuid; oB uuid; s uuid; cJuan uuid; cCarol uuid; res jsonb; inst public.shift_instances;
begin
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- CYCLE A: offer, two requests, then cancel
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  oA := gen_random_uuid();
  s  := mk(alice, '2027-07-01', 'scheduled', 'offered', oA, now());
  cJuan  := mkc(s, bob,   'pending', 'pickup_request', oA);
  cCarol := mkc(s, carol, 'pending', 'pickup_request', oA);

  res := public.lensed_cancel_shift_offer(A, alice, s, oA);
  perform t_eq('cancel: ok',                       res->>'ok',         'true');
  perform t_eq('cancel: superseded 2 requests',    res->>'superseded', '2');

  select * into inst from public.shift_instances where id = s;
  perform t_eq('cancel: offer_state -> closed',            inst.offer_state,  'closed');
  perform t_eq('cancel: offer_id RETAINED as history',     inst.offer_id,     oA);
  perform t_eq('cancel: offered_at RETAINED',              (inst.offered_at is not null), true);
  -- The four "nothing happened to my shift" invariants.
  perform t_eq('cancel: STILL assigned to the offerer',    inst.employee_id,  alice);
  perform t_eq('cancel: status untouched',                 inst.status,       'scheduled');
  perform t_eq('cancel: released_at still NULL',           inst.released_at,  null::timestamptz);
  perform t_eq('cancel: still clock-eligible',
    (inst.status in ('scheduled','claimed') and inst.released_at is null), true);

  perform t_eq('cancel: Juan''s request superseded',  (select status from public.shift_claims where id=cJuan),  'superseded');
  perform t_eq('cancel: Carol''s request superseded', (select status from public.shift_claims where id=cCarol), 'superseded');
  perform t_eq('cancel: NOTHING left pending for this shift',
    (select count(*)::int from public.shift_claims where shift_instance_id=s and status='pending'), 0);

  -- Cancelling is the OPPOSITE of dropping; it must cost nothing.
  perform t_eq('cancel: NO attendance event', (select count(*)::int from public.attendance_events), 0);
  perform t_eq('cancel: NO payroll row',      (select count(*)::int from public.shifts), 0);

  -- ═══ REPEATED / INVALID CANCELS ═══
  res := public.lensed_cancel_shift_offer(A, alice, s, oA);
  perform t_eq('cancel twice: refused',                res->>'ok',          'false');
  perform t_eq('cancel twice: reason OFFER_NOT_OPEN',  res->>'reason',      'OFFER_NOT_OPEN');
  perform t_eq('cancel twice: reports closed so the UI can no-op', res->>'offer_state', 'closed');
  perform t_eq('cancel twice: state unchanged',
    (select offer_state from public.shift_instances where id=s), 'closed');

  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- CYCLE B: re-offer. THE TRAP TEST.
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  oB := gen_random_uuid();
  update public.shift_instances set offer_state='offered', offer_id=oB, offered_at=now() where id=s;
  perform t_eq('re-offer: cycle B has a DIFFERENT offer_id', (oB is distinct from oA), true);
  perform t_eq('re-offer: old cycle A claims stay superseded',
    (select status from public.shift_claims where id=cJuan), 'superseded');

  -- Without cancel having superseded cycle A, this insert would violate
  -- idx_shift_claims_one_pending_pickup_per_employee and Juan could NEVER ask again.
  declare cJuanB uuid;
  begin
    cJuanB := mkc(s, bob, 'pending', 'pickup_request', oB);
    perform t_eq('re-offer: Juan CAN request again under cycle B',
      (select status from public.shift_claims where id=cJuanB), 'pending');
    perform t_eq('re-offer: his cycle-B request carries the NEW offer_id',
      (select offer_id from public.shift_claims where id=cJuanB), oB);

    -- ═══ A STALE CYCLE-A MANAGER ACTION MUST NOT TOUCH CYCLE B ═══
    res := public.lensed_approve_shift_pickup(A, s, cJuan, oA, pp);
    perform t_eq('stale: approving the dead cycle-A claim is refused', res->>'ok', 'false');
    perform t_eq('stale: reason CLAIM_NOT_PENDING', res->>'reason', 'CLAIM_NOT_PENDING');
    perform t_eq('stale: shift still owned by the offerer',
      (select employee_id from public.shift_instances where id=s), alice);
    perform t_eq('stale: cycle B still open',
      (select offer_state from public.shift_instances where id=s), 'offered');
    perform t_eq('stale: no attendance written', (select count(*)::int from public.attendance_events), 0);

    -- A cancel carrying the OLD cycle id must not close the NEW cycle.
    res := public.lensed_cancel_shift_offer(A, alice, s, oA);
    perform t_eq('stale: cancelling with cycle-A id is refused', res->>'ok',     'false');
    perform t_eq('stale: reason STALE_OFFER',                    res->>'reason', 'STALE_OFFER');
    perform t_eq('stale: cycle B survived',
      (select offer_id from public.shift_instances where id=s), oB);

    -- Cycle B can then be approved normally — the lifecycle is not wedged.
    res := public.lensed_approve_shift_pickup(A, s, cJuanB, oB, pp);
    perform t_eq('re-offer: cycle B approves cleanly',   res->>'ok',          'true');
    perform t_eq('re-offer: shift transfers to Juan',    res->>'employee_id', bob::text);
    perform t_eq('re-offer: attendance written ONCE for the real handoff',
      (select count(*)::int from public.attendance_events where shift_instance_id=s), 2);
  end;

  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- AUTHORIZATION
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  declare o4 uuid := gen_random_uuid(); s4 uuid; snap public.shift_instances;
  begin
    s4 := mk(alice, '2027-07-05', 'scheduled', 'offered', o4, now());
    select * into snap from public.shift_instances where id = s4;

    res := public.lensed_cancel_shift_offer(A, bob, s4, o4);
    perform t_eq('auth: a COWORKER cannot cancel it',    res->>'reason', 'NOT_YOUR_SHIFT');
    res := public.lensed_cancel_shift_offer(B, alice, s4, o4);
    perform t_eq('auth: a FOREIGN OWNER cannot cancel it', res->>'reason', 'SHIFT_NOT_FOUND');
    res := public.lensed_cancel_shift_offer(A, alice, gen_random_uuid(), o4);
    perform t_eq('auth: unknown shift -> SHIFT_NOT_FOUND', res->>'reason', 'SHIFT_NOT_FOUND');
    res := public.lensed_cancel_shift_offer(A, alice, s4, gen_random_uuid());
    perform t_eq('auth: wrong offer cycle -> STALE_OFFER', res->>'reason', 'STALE_OFFER');

    perform t_eq('auth: every refusal left the row untouched',
      (select i from public.shift_instances i where i.id=s4) is not distinct from snap, true);

    -- A shift that is not offered at all cannot be cancelled.
    declare s5 uuid := mk(alice, '2027-07-06');
    begin
      res := public.lensed_cancel_shift_offer(A, alice, s5, gen_random_uuid());
      perform t_eq('auth: never-offered shift -> OFFER_NOT_OPEN', res->>'reason', 'OFFER_NOT_OPEN');
    end;
  end;

  -- ═══ CANCEL AFTER A TRANSFER REPORTS THE TRANSFER, NOT A GENERIC FAILURE ═══
  declare o6 uuid := gen_random_uuid(); s6 uuid; c6 uuid;
  begin
    s6 := mk(alice, '2027-07-07', 'scheduled', 'offered', o6, now());
    c6 := mkc(s6, carol, 'pending', 'pickup_request', o6);
    perform public.lensed_approve_shift_pickup(A, s6, c6, o6, pp);
    res := public.lensed_cancel_shift_offer(A, alice, s6, o6);
    -- The shift is Carol's now, so the ownership check fires before the offer-state one. Either
    -- refusal is honest; asserting the exact reason pins which message the worker sees.
    perform t_eq('post-transfer: cancel refused as NOT_YOUR_SHIFT', res->>'reason', 'NOT_YOUR_SHIFT');
    perform t_eq('post-transfer: transfer stands', (select employee_id from public.shift_instances where id=s6), carol);
  end;
end $$;

select t_report('Cancel Offer + re-offer lifecycle');
