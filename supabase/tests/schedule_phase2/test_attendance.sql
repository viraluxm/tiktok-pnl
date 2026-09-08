-- ATTENDANCE BOOKKEEPING (migration 130).
--
-- ─── THE RULE BEING ENFORCED ───────────────────────────────────────────────────────────────────
-- OFFERING a shift must NOT consume a drop. The worker who presses Drop Shift is still fully
-- responsible for that shift and still clock-eligible for it, so charging them the moment they ask
-- for cover — and leaving the charge standing if nobody takes it — was simply wrong.
--
-- Bookkeeping happens once, at TRANSFER, and writes the same pair the legacy release/claim path
-- writes, because computeDrops() is per-employee: drops = max(0, releases − claims) over ONE
-- employee_id in ONE pay period.
--   ('released', outgoing employee) — he really did give up a shift
--   ('claimed',  incoming employee) — he really did take on extra coverage, and is credited
-- A 'claimed' row does NOT forgive the releaser; it credits the CLAIMER's own ledger.
\set QUIET on
set client_min_messages = notice;
delete from public.attendance_events;
delete from public.shift_claims;
delete from public.shift_instances;

-- Mirror of src/lib/schedule/drops.ts, so the harness asserts the SAME arithmetic the app shows.
create or replace function t_drops(p_emp uuid, p_period date)
returns table(releases int, claims int, drops int) language sql stable as $$
  with ev as (select event_type, shift_date from public.attendance_events
               where employee_id = p_emp and pay_period_start = p_period),
       ex as (select shift_date from ev where event_type = 'excused'),
       rel as (select count(*)::int n from ev
                where event_type = 'released' and shift_date not in (select shift_date from ex)),
       cl as (select count(*)::int n from ev where event_type = 'claimed')
  select rel.n, cl.n, greatest(0, rel.n - cl.n) from rel, cl;
$$;

do $$
declare
  A     uuid := 'a0000000-0000-4000-8000-000000000001';
  alice uuid := 'e1111111-0000-4000-8000-000000000001';  -- outgoing (Carlos in the product story)
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';  -- incoming (Juan)
  carol uuid := 'e3333333-0000-4000-8000-000000000003';  -- rival
  pp date := date '2026-09-07';
  o1 uuid; s uuid; cb uuid; cc uuid; res jsonb; n int;
begin
  o1 := gen_random_uuid();
  s  := mk(alice, '2026-12-01', 'scheduled', 'offered', o1, now());   -- the OFFER already happened

  -- ═══ OFFERING WRITES NOTHING ═══
  -- offer.ts no longer inserts here at all; the offered row above is the post-offer state.
  perform t_eq('offer: zero attendance events exist after offering',
    (select count(*)::int from public.attendance_events where shift_instance_id = s), 0);
  perform t_eq('offer: outgoing employee has ZERO drops', (select drops from t_drops(alice, pp)), 0);
  perform t_eq('offer: outgoing employee has ZERO releases', (select releases from t_drops(alice, pp)), 0);

  -- ═══ A PICKUP REQUEST WRITES NOTHING ═══
  cb := mkc(s, bob,   'pending', 'pickup_request', o1);
  cc := mkc(s, carol, 'pending', 'pickup_request', o1);
  perform t_eq('request: still zero attendance events',
    (select count(*)::int from public.attendance_events where shift_instance_id = s), 0);
  perform t_eq('request: requester earns no credit yet', (select claims from t_drops(bob, pp)), 0);

  -- ═══ APPROVAL WRITES EXACTLY THE PAIR ═══
  res := public.lensed_approve_shift_pickup(A, s, cb, o1, pp);
  perform t_eq('approve: ok', res->>'ok', 'true');
  perform t_eq('approve: reports 2 attendance events', res->>'attendance_events', '2');
  perform t_eq('approve: exactly 2 rows written',
    (select count(*)::int from public.attendance_events where shift_instance_id = s), 2);
  perform t_eq('approve: released row is on the OUTGOING employee',
    (select employee_id from public.attendance_events where shift_instance_id=s and event_type='released'), alice);
  perform t_eq('approve: claimed row is on the INCOMING employee',
    (select employee_id from public.attendance_events where shift_instance_id=s and event_type='claimed'), bob);
  perform t_eq('approve: both rows carry the caller-supplied pay period',
    (select count(*)::int from public.attendance_events where shift_instance_id=s and pay_period_start=pp), 2);
  perform t_eq('approve: both rows carry the shift date',
    (select count(*)::int from public.attendance_events where shift_instance_id=s and shift_date=date '2026-12-01'), 2);
  perform t_eq('approve: NO event for the losing rival',
    (select count(*)::int from public.attendance_events where employee_id = carol), 0);

  -- ═══ THE COUNTERS THEMSELVES ═══
  perform t_eq('counter: outgoing employee now has 1 release', (select releases from t_drops(alice, pp)), 1);
  perform t_eq('counter: outgoing employee now has 1 DROP',    (select drops    from t_drops(alice, pp)), 1);
  perform t_eq('counter: incoming employee has 1 claim',       (select claims   from t_drops(bob, pp)), 1);
  -- The credit lands on the CLAIMER's ledger, not the releaser's — this is the assertion that pins
  -- the audited semantics. If someone "fixes" the RPC to offset the releaser instead, this fails.
  perform t_eq('counter: incoming employee has 0 drops (credit is HIS, not a forgiveness of hers)',
    (select drops from t_drops(bob, pp)), 0);

  -- ═══ REPLAY WRITES NO DUPLICATES ═══
  -- Guarded by the CAS, not a unique index (an index on (instance, employee, type) would wrongly
  -- forbid the legitimate Carlos→Juan→Carlos→Juan cycle).
  res := public.lensed_approve_shift_pickup(A, s, cb, o1, pp);
  perform t_eq('replay: refused',                       res->>'ok',     'false');
  perform t_eq('replay: reason ALREADY_APPROVED',       res->>'reason', 'ALREADY_APPROVED');
  perform t_eq('replay: STILL exactly 2 events',
    (select count(*)::int from public.attendance_events where shift_instance_id = s), 2);
  perform t_eq('replay: counters unchanged', (select drops from t_drops(alice, pp)), 1);

  -- ═══ A ROLLED-BACK APPROVAL WRITES NO EVENT ═══
  declare o2 uuid := gen_random_uuid(); s2 uuid; c2 uuid; caught text; before_n int;
  begin
    s2 := mk(alice, '2026-12-02', 'scheduled', 'offered', o2, now());
    perform mkc(s2, carol, 'approved', 'pickup_request', gen_random_uuid()); -- index-A slot taken
    c2 := mkc(s2, bob, 'pending', 'pickup_request', o2);
    select count(*)::int into before_n from public.attendance_events;
    begin
      res := public.lensed_approve_shift_pickup(A, s2, c2, o2, pp);
      caught := 'NO EXCEPTION';
    exception when others then caught := SQLSTATE;
    end;
    perform t_eq('rollback: approval aborted (23505)', caught, '23505');
    perform t_eq('rollback: NO attendance event survived',
      (select count(*)::int from public.attendance_events), before_n);
    perform t_eq('rollback: outgoing employee NOT charged a second drop',
      (select drops from t_drops(alice, pp)), 1);
  end;

  -- ═══ A DECLINE WRITES NO TRANSFER EVENT ═══
  -- declinePickup only flips the claim row; it must never touch attendance.
  declare o3 uuid := gen_random_uuid(); s3 uuid; c3 uuid; before_n int;
  begin
    s3 := mk(alice, '2026-12-03', 'scheduled', 'offered', o3, now());
    c3 := mkc(s3, bob, 'pending', 'pickup_request', o3);
    select count(*)::int into before_n from public.attendance_events;
    update public.shift_claims set status='rejected' where id=c3;   -- what declinePickup does
    perform t_eq('decline: no attendance event written',
      (select count(*)::int from public.attendance_events), before_n);
    perform t_eq('decline: offer still open for others',
      (select offer_state from public.shift_instances where id=s3), 'offered');
  end;

  -- ═══ NO PAYROLL ROW, EVER ═══
  perform t_eq('payroll: scheduling wrote zero `shifts` rows', (select count(*)::int from public.shifts), 0);
end $$;

select t_report('attendance bookkeeping at transfer time');
