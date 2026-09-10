-- shift_trades constraints (migration 136, section 1).
\set QUIET on
set client_min_messages = notice;
delete from public.shift_trades;
delete from public.shift_claims;
delete from public.shift_instances;

do $$
declare
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  bob   uuid := 'e2222222-0000-4000-8000-000000000002';
  carol uuid := 'e3333333-0000-4000-8000-000000000003';
  a uuid; b uuid; c uuid; t uuid;
begin
  a := mk(alice, '2027-01-05');
  b := mk(bob,   '2027-01-07');
  c := mk(carol, '2027-01-09');

  -- ═══ ACCEPTED SHAPES ═══
  perform t_accept('shape: fresh proposal (pending_coworker, no response)',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', alice, a, bob, b));
  delete from public.shift_trades;
  perform t_accept('shape: accepted, waiting for manager',
    format('select mkt(%L,%L,%L,%L,''pending_manager'',''accepted'')', alice, a, bob, b));
  delete from public.shift_trades;
  perform t_accept('shape: declined by coworker',
    format('select mkt(%L,%L,%L,%L,''declined'',''declined'')', alice, a, bob, b));
  perform t_accept('shape: cancelled',
    format('select mkt(%L,%L,%L,%L,''cancelled'',null)', alice, a, bob, b));
  delete from public.shift_trades;

  -- ═══ VOCABULARY ═══
  perform t_reject('status: bogus',
    format('select mkt(%L,%L,%L,%L,''bogus'',null)', alice, a, bob, b), 'shift_trades_status_check');
  perform t_reject('response: bogus',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',''maybe'')', alice, a, bob, b), 'shift_trades_response_check');

  -- ═══ STRUCTURE ═══
  perform t_reject('two people: same employee both sides',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', alice, a, alice, b), 'shift_trades_two_people');
  perform t_reject('two shifts: same instance both sides',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', alice, a, bob, a), 'shift_trades_two_shifts');
  perform t_reject('pending_manager REQUIRES an acceptance',
    format('select mkt(%L,%L,%L,%L,''pending_manager'',null)', alice, a, bob, b), 'shift_trades_manager_stage_has_acceptance');
  perform t_reject('pending_manager with a decline is contradictory',
    format('select mkt(%L,%L,%L,%L,''pending_manager'',''declined'')', alice, a, bob, b), 'shift_trades_manager_stage_has_acceptance');
  perform t_reject('approved must carry decided_by/decided_at',
    format('select mkt(%L,%L,%L,%L,''approved'',''accepted'')', alice, a, bob, b), 'shift_trades_approved_is_decided');

  -- ═══ ONE LIVE TRADE PER SHIFT, PER SIDE ═══
  t := mkt(alice, a, bob, b, 'pending_coworker', null);
  perform t_reject('live requester shift cannot be proposed twice',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', alice, a, carol, c), 'idx_shift_trades_live_requester_shift');
  perform t_reject('live target shift cannot be asked for twice',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', carol, c, bob, b), 'idx_shift_trades_live_target_shift');
  -- Terminal rows never block a new proposal.
  update public.shift_trades set status = 'cancelled', cancelled_at = now() where id = t;
  perform t_accept('a cancelled trade frees both shifts for a new proposal',
    format('select mkt(%L,%L,%L,%L,''pending_coworker'',null)', alice, a, bob, b));
  delete from public.shift_trades;

  -- ═══ updated_at trigger ═══
  -- now() is frozen for the whole transaction, so "updated_at advanced" cannot be observed inside
  -- this block; assert the trigger is wired to the shared set_updated_at() instead.
  perform t_eq('updated_at trigger is installed',
    (select count(*)::int from pg_trigger where tgrelid = 'public.shift_trades'::regclass and tgname = 'shift_trades_set_updated_at' and not tgisinternal), 1);
  perform t_eq('updated_at trigger calls set_updated_at()',
    (select p.proname from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid where tg.tgrelid = 'public.shift_trades'::regclass and tg.tgname = 'shift_trades_set_updated_at'), 'set_updated_at');
end $$;

select t_report('shift_trades constraints');
