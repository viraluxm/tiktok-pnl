-- ATOMICITY / TORN-STATE REGRESSION for lensed_approve_shift_pickup.
--
-- ─── WHAT BUG THIS GUARDS ──────────────────────────────────────────────────────────────────────
-- An earlier draft of migration 129 `return`ed a refusal jsonb from EVERY failure path, including
-- the ones AFTER the assignment UPDATE had already run. `return` does not roll anything back, so
-- the caller was told "refused" while the transfer stayed committed: the shift moved to a new
-- owner with no approved claim behind it, and the CAS pre-state was consumed so it could never be
-- re-approved. That is precisely the half-state this RPC exists to prevent.
--
-- The fix: every failure path past the assignment RAISES. These tests fail if anyone reverts that.
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
  o1 uuid; o2 uuid; s uuid; c uuid; res jsonb; before_i public.shift_instances; caught text;
begin
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- 1. EMPLOYEE_DOUBLE_BOOKED — the one unique_violation that IS caught.
  --    Its exception block rolls back only its own subtransaction, and nothing else had been
  --    written yet, so returning a refusal here is safe. Prove the instance is untouched.
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  o1 := gen_random_uuid();
  perform mk(bob, '2027-02-01');                                    -- Bob already works that day
  s := mk(alice, '2027-02-01', 'scheduled', 'offered', o1, now());  -- Alice offers hers
  c := mkc(s, bob, 'pending', 'pickup_request', o1);
  select * into before_i from public.shift_instances where id = s;

  res := public.lensed_approve_shift_pickup(A, s, c, o1, date '2026-09-07');
  perform t_eq('double-book: refused',                       res->>'ok',     'false');
  perform t_eq('double-book: reason EMPLOYEE_DOUBLE_BOOKED', res->>'reason', 'EMPLOYEE_DOUBLE_BOOKED');
  perform t_eq('double-book: instance FULLY unchanged',
    (select i from public.shift_instances i where i.id = s) is not distinct from before_i, true);
  perform t_eq('double-book: still owned by Alice',
    (select employee_id from public.shift_instances where id=s), alice);
  perform t_eq('double-book: offer still OPEN (not transferred)',
    (select offer_state from public.shift_instances where id=s), 'offered');
  perform t_eq('double-book: claim still pending',
    (select status from public.shift_claims where id=c), 'pending');

  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- 2. POST-ASSIGNMENT FAILURE MUST ROLL THE TRANSFER BACK.
  --    Reached by letting the winner UPDATE collide with idx_shift_claims_one_approved_pickup,
  --    which 129 deliberately does NOT catch. The assignment has already succeeded at that point,
  --    so if the error were swallowed the shift would be left moved with no approved claim.
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  o1 := gen_random_uuid(); o2 := gen_random_uuid();
  s := mk(alice, '2027-03-01', 'scheduled', 'offered', o2, now());
  perform mkc(s, carol, 'approved', 'pickup_request', o1);  -- index-A slot already taken
  c := mkc(s, bob, 'pending', 'pickup_request', o2);
  select * into before_i from public.shift_instances where id = s;

  begin
    res := public.lensed_approve_shift_pickup(A, s, c, o2, date '2026-09-07');
    caught := 'NO EXCEPTION — returned '||res::text;
  exception when others then
    caught := SQLSTATE;   -- 23505 unique_violation
  end;
  perform t_eq('rollback: uncaught unique_violation aborts (SQLSTATE 23505)', caught, '23505');
  perform t_eq('rollback: instance FULLY restored',
    (select i from public.shift_instances i where i.id = s) is not distinct from before_i, true);
  perform t_eq('rollback: employee_id NOT moved (still Alice)',
    (select employee_id from public.shift_instances where id=s), alice);
  perform t_eq('rollback: offer_state NOT transferred',
    (select offer_state from public.shift_instances where id=s), 'offered');
  perform t_eq('rollback: status NOT flipped to claimed',
    (select status from public.shift_instances where id=s), 'scheduled');
  perform t_eq('rollback: winner claim still pending',
    (select status from public.shift_claims where id=c), 'pending');

  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  -- 3. THE GLOBAL INVARIANT: a refusal must NEVER coexist with a mutated instance.
  -- ═══════════════════════════════════════════════════════════════════════════════════════════
  declare
    st text; ok_all boolean := true; sx uuid; cx uuid; ox uuid; snap public.shift_instances;
  begin
    foreach st in array array['scheduled','claimed'] loop
      ox := gen_random_uuid();
      sx := mk(alice, ('2027-04-0'||(case st when 'scheduled' then '1' else '2' end))::date, st, 'offered', ox, now());
      cx := mkc(sx, carol, 'pending', 'pickup_request', ox);
      update public.shift_instances set offer_id = gen_random_uuid() where id = sx;  -- new generation
      select * into snap from public.shift_instances where id = sx;
      res := public.lensed_approve_shift_pickup(A, sx, cx, ox, date '2026-09-07');
      if res->>'ok' = 'false'
         and (select i from public.shift_instances i where i.id=sx) is distinct from snap then
        ok_all := false;
      end if;
    end loop;
    perform t_eq('invariant: refusal NEVER coexists with a mutated instance', ok_all, true);
  end;
end $$;

select t_report('atomicity / torn-state regression');
