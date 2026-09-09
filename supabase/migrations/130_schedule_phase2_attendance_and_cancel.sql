-- 130_schedule_phase2_attendance_and_cancel.sql
--
-- ⚠️ NOT APPLIED. Additive follow-up to 129, which IS live.
--    129 (offer lifecycle: columns, CHECKs, indexes, approval RPC) was hand-applied to production
--    on 2026-09-06 and is FROZEN — this file must never re-issue its ALTER TABLE / CREATE INDEX
--    statements. This DB has NO migration ledger; the repo file is the only record.
--    ➜ RE-INSPECT THE LIVE SCHEMA BEFORE APPLYING. Prefix 130 was free across origin/main, every
--      local and remote branch, and every sibling worktree at authoring time (129 is the highest).
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Two Phase 2 blockers, both of which must be transactional and therefore belong in the database.
--
-- 1. ATTENDANCE TIMING. Phase 2 wrote a legacy 'released' attendance_event the moment an employee
--    pressed Drop Shift. That charged them a drop for merely OFFERING, while they were still fully
--    responsible for the shift — and if nobody took it, the drop stood anyway. The event must move
--    to the moment a transfer actually happens, inside the same transaction as the transfer.
--
-- 2. CANCEL OFFER. An employee who offered a shift had no way to take the offer back. Closing an
--    offer touches the shift AND every pending request for that cycle, so it has the same
--    all-or-nothing requirement as approval, and it must serialize against approval.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- THE ATTENDANCE ACCOUNTING, AS PROVEN FROM THE EXISTING CODE (not assumed)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- src/lib/schedule/drops.ts:  drops = max(0, releases − claims), and every reader
-- (board.ts getCurrentPeriodDrops, release.ts's pre-release gate, /api/member/team/attendance)
-- filters attendance_events by ONE employee_id and one pay_period_start. So the counter is
-- PER EMPLOYEE PER PAY PERIOD — never team-wide.
--
-- Whose id goes on each row, from the existing writers:
--   release.ts:107     'released' ← employee_id = THE RELEASER (the person giving the shift up)
--   claim.ts:142       'claimed'  ← employee_id = THE CLAIMER  (the person taking it on)
--   adminShifts.ts:263 'claimed'  ← employee_id = claim.claimed_by (the approved claimer)
--
-- Therefore a 'claimed' event does NOT forgive the releaser's drop. It credits the CLAIMER's own
-- ledger: you gave one up, you picked one up, you net to zero *for yourself*. That is what the
-- "exchange netting" comment in drops.ts means operationally.
--
-- So the correct rows at TRANSFER time (Carlos → Juan) are exactly the legacy pair, written
-- together instead of hours apart:
--   ('released', employee_id = Carlos)  — he really did give up a shift, and only now is it real
--   ('claimed',  employee_id = Juan)    — he really did take on extra coverage, and is credited
--
-- SECOND, NON-OBVIOUS CONSUMER — and the reason the 'released' row is load-bearing rather than
-- merely cosmetic. The forward materializer's REGENERATION GUARD
-- (src/lib/schedule/materializeForward.ts) skips (employee_id, shift_date) when an unresolved
-- 'released'/'missed_unfilled' event exists for that pair. After a transfer the instance belongs
-- to Juan, so the key (Carlos, shift_date) has no instance left — without the 'released' row the
-- materializer would happily regenerate Carlos's pattern shift for that very date and hand him
-- back the shift he just gave away. UNIQUE(employee_id, shift_date) would not stop it: Carlos and
-- Juan are different keys.
--
-- WHY NO UNIQUE INDEX FOR REPLAY SAFETY. A natural instinct is UNIQUE(shift_instance_id,
-- employee_id, event_type). It would be WRONG: Carlos may legitimately release the same instance
-- more than once across cycles (Carlos→Juan, Juan→Carlos, Carlos→Juan again). Replay safety comes
-- instead from the CAS already in 129 — the second approval sees offer_state='transferred' and
-- returns ALREADY_APPROVED before reaching any write. The harness asserts exactly that.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THE APPROVAL RPC'S SIGNATURE CHANGES (p_pay_period_start)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- attendance_events.pay_period_start is a biweekly window anchored on PAY_ANCHOR ('2026-07-17'),
-- computed by payPeriodContaining() in src/lib/employees.ts. That arithmetic exists ONLY in
-- TypeScript — no migration computes it; SQL merely stores the result. Re-implementing it in
-- PL/pgSQL would fork money-adjacent logic across two languages with no test tying them together,
-- and a drift would silently file drops into the wrong pay period.
--
-- So the caller passes the value it already computes for release.ts and claim.ts, keeping ONE
-- source of truth. That is a genuine reason to change the signature rather than a convenience.
--
-- Changing it is safe RIGHT NOW and only right now: Phase 2 is unmerged, so the live 4-arg
-- function has ZERO callers (`git grep lensed_approve_shift_pickup origin/main -- src/` is empty).
-- The old overload is dropped explicitly, because CREATE OR REPLACE with a different argument list
-- creates a SECOND overload rather than replacing — leaving a stale 4-arg function that writes no
-- attendance rows, which is precisely the bug this migration fixes.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. APPROVAL — same transfer, now with the attendance pair, atomically
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Drop the superseded 4-arg overload FIRST (see the signature note above). `if exists` so a fresh
-- database that never had 129's version applies cleanly.
drop function if exists public.lensed_approve_shift_pickup(uuid, uuid, uuid, uuid);

create or replace function public.lensed_approve_shift_pickup(
  p_owner             uuid,
  p_shift_instance_id uuid,
  p_claim_id          uuid,
  p_offer_id          uuid,
  p_pay_period_start  date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_claim   public.shift_claims;
  v_inst    public.shift_instances;
  v_emp_ok  boolean;
  v_superseded int := 0;
  v_prev_employee uuid;
begin
  if p_owner is null then raise exception 'INVALID_OWNER'; end if;
  if p_pay_period_start is null then raise exception 'INVALID_PAY_PERIOD'; end if;

  -- Serialize every approval AND cancel for this shift, so two actors queue rather than race.
  -- lensed_cancel_shift_offer takes this SAME key — that is what makes approve/cancel mutually
  -- exclusive rather than merely CAS-lucky.
  perform pg_advisory_xact_lock(hashtextextended(p_shift_instance_id::text, 0));

  -- ── Lock and validate the target claim. Owner, kind, cycle and shift are all predicates. ──
  select * into v_claim
    from public.shift_claims
   where id = p_claim_id
     and user_id = p_owner
     and shift_instance_id = p_shift_instance_id
     and kind = 'pickup_request'
     and offer_id = p_offer_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'CLAIM_NOT_FOUND');
  end if;
  if v_claim.status <> 'pending' then
    -- Idempotent-safe: re-approving an already-approved claim reports the terminal state rather
    -- than writing again. This is ALSO the replay guard for the attendance rows below.
    return jsonb_build_object('ok', false, 'reason',
      case when v_claim.status = 'approved' then 'ALREADY_APPROVED' else 'CLAIM_NOT_PENDING' end,
      'claim_status', v_claim.status);
  end if;

  -- ── Lock and validate the shift. The offer cycle must still be the one this claim belongs to. ──
  select * into v_inst
    from public.shift_instances
   where id = p_shift_instance_id
     and user_id = p_owner
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_FOUND');
  end if;
  if v_inst.offer_state is distinct from 'offered' then
    -- Also the CANCEL-WON branch: a cancelled offer is 'closed', so a manager acting on a stale
    -- queue gets this clean refusal instead of transferring a shift nobody is offering.
    return jsonb_build_object('ok', false, 'reason', 'OFFER_NOT_OPEN', 'offer_state', v_inst.offer_state);
  end if;
  if v_inst.offer_id is distinct from p_offer_id then
    -- THE ABA GUARD. The shift was re-offered under a new generation; this claim belongs to a dead
    -- cycle and must not transfer anything.
    return jsonb_build_object('ok', false, 'reason', 'STALE_OFFER');
  end if;
  if v_inst.employee_id is null then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_UNOWNED');
  end if;
  if v_inst.employee_id = v_claim.claimed_by then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_ASSIGNED');
  end if;
  v_prev_employee := v_inst.employee_id;

  -- ── The incoming employee must still be a real, active employee of this owner. ──
  select true into v_emp_ok
    from public.employees
   where id = v_claim.claimed_by and user_id = p_owner and status = 'active';
  if v_emp_ok is not true then
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_UNAVAILABLE');
  end if;

  -- ── The transfer. UNIQUE(employee_id, shift_date) is the backstop if the claimer picked up
  --    another shift that day between requesting and approval; surfaced as a clean refusal.
  begin
    update public.shift_instances
       set employee_id = v_claim.claimed_by,
           status      = 'claimed',
           released_at = null,          -- keep the new owner clock-eligible (PR #217's invariant)
           source      = 'claim',
           offer_state = 'transferred'  -- offer_id / offered_at retained as audit history
     where id = p_shift_instance_id
       and user_id = p_owner
       and offer_state = 'offered'      -- CAS: re-asserted so a concurrent close cannot be overwritten
       and offer_id = p_offer_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'OFFER_CHANGED');
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'EMPLOYEE_DOUBLE_BOOKED');
  end;

  -- ── The winner. ──
  --
  -- ORDERING MATTERS FROM HERE DOWN. The assignment has already moved, so a `return` past this
  -- point would hand the caller a refusal while the transfer stayed committed — a torn state, and
  -- precisely what this function exists to prevent. Every failure below therefore RAISES, which
  -- aborts the function and rolls the whole transfer back. (The EMPLOYEE_DOUBLE_BOOKED handler
  -- above can safely `return` because its exception block rolls back the instance update itself
  -- and nothing else had been written yet.)
  update public.shift_claims
     set status = 'approved', approved_by = p_owner, approved_at = now()
   where id = p_claim_id and status = 'pending';
  if not found then
    raise exception 'PICKUP_WINNER_VANISHED claim=% shift=%', p_claim_id, p_shift_instance_id;
  end if;
  -- NOTE: idx_shift_claims_one_approved_pickup can also fire on this statement if another pickup
  -- for this shift is somehow already approved. That unique_violation is deliberately NOT caught:
  -- an unhandled error aborts the transaction and rolls the transfer back, which is the correct
  -- outcome. Catching it would leave the assignment moved with no approved claim behind it.

  -- ── The rivals: same shift, same cycle, still pending. Closed honestly, not "rejected". ──
  update public.shift_claims
     set status = 'superseded', approved_by = p_owner, approved_at = now()
   where shift_instance_id = p_shift_instance_id
     and user_id = p_owner
     and kind = 'pickup_request'
     and offer_id = p_offer_id
     and status = 'pending'
     and id <> p_claim_id;
  get diagnostics v_superseded = row_count;

  -- ── ATTENDANCE. The handoff is real as of this statement, so the bookkeeping happens HERE and
  --    nowhere else. Two rows, matching the legacy release/claim pair exactly (see the header):
  --    the OUTGOING employee is charged, the INCOMING employee is credited. Same transaction as
  --    the transfer, so there is no state in which one exists without the other.
  --
  --    Still inside the raise-don't-return zone: a failure here aborts and un-does the transfer.
  insert into public.attendance_events
    (user_id, employee_id, shift_instance_id, shift_date, event_type, pay_period_start)
  values
    (p_owner, v_prev_employee,      p_shift_instance_id, v_inst.shift_date, 'released', p_pay_period_start),
    (p_owner, v_claim.claimed_by,   p_shift_instance_id, v_inst.shift_date, 'claimed',  p_pay_period_start);

  return jsonb_build_object(
    'ok', true,
    'shift_instance_id', p_shift_instance_id,
    'employee_id', v_claim.claimed_by,
    'previous_employee_id', v_prev_employee,
    'offer_id', p_offer_id,
    'superseded', v_superseded,
    'attendance_events', 2
  );
end;
$body$;

revoke execute on function public.lensed_approve_shift_pickup(uuid, uuid, uuid, uuid, date) from public, anon, authenticated;
grant  execute on function public.lensed_approve_shift_pickup(uuid, uuid, uuid, uuid, date) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2. CANCEL OFFER — the employee takes their own offer back
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Closing an offer is two writes that must not come apart: the shift leaves the board, and every
-- pending request for THAT CYCLE stops being actionable. If the second half were skipped, the
-- manager queue would keep showing requests for a shift nobody is offering, and — because
-- idx_shift_claims_one_pending_pickup_per_employee is keyed on the SHIFT, not the cycle — the
-- same coworker could never request the shift again after a re-offer. Superseding here is what
-- closes that trap.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   • no attendance_event — cancelling is the opposite of dropping; charging for it would be worse
--     than the bug this whole migration removes
--   • no payroll row — shift_instances is the PLAN and never feeds pay
--   • employee_id, status and released_at are untouched — the shift was never not theirs
--
-- p_employee_id is the ACTING employee, resolved server-side from the permanent employee token and
-- never taken from a request body. It is asserted against the row's current owner so one worker
-- can never cancel another's offer even with a valid token of their own.
create or replace function public.lensed_cancel_shift_offer(
  p_owner             uuid,
  p_employee_id       uuid,
  p_shift_instance_id uuid,
  p_offer_id          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_inst public.shift_instances;
  v_superseded int := 0;
begin
  if p_owner is null       then raise exception 'INVALID_OWNER';    end if;
  if p_employee_id is null then raise exception 'INVALID_EMPLOYEE'; end if;

  -- SAME advisory key as lensed_approve_shift_pickup. Approve and cancel are mutually exclusive by
  -- construction: whoever takes the lock first runs to completion, and the loser then fails its
  -- own offer_state/offer_id checks against the committed result.
  perform pg_advisory_xact_lock(hashtextextended(p_shift_instance_id::text, 0));

  select * into v_inst
    from public.shift_instances
   where id = p_shift_instance_id
     and user_id = p_owner
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'SHIFT_NOT_FOUND');
  end if;
  if v_inst.employee_id is distinct from p_employee_id then
    -- Covers both "not yours" and "already transferred to someone else while you were deciding".
    return jsonb_build_object('ok', false, 'reason', 'NOT_YOUR_SHIFT');
  end if;
  if v_inst.offer_state is distinct from 'offered' then
    -- The APPROVE-WON branch reports 'transferred'; an already-cancelled offer reports 'closed',
    -- which the caller can present as a no-op rather than an error.
    return jsonb_build_object('ok', false, 'reason', 'OFFER_NOT_OPEN', 'offer_state', v_inst.offer_state);
  end if;
  if v_inst.offer_id is distinct from p_offer_id then
    return jsonb_build_object('ok', false, 'reason', 'STALE_OFFER');
  end if;

  -- ── Close the cycle. offer_id / offered_at are RETAINED so the closed cycle stays auditable and
  --    so a later re-offer is visibly a different generation.
  update public.shift_instances
     set offer_state = 'closed'
   where id = p_shift_instance_id
     and user_id = p_owner
     and employee_id = p_employee_id
     and offer_state = 'offered'   -- CAS against a concurrent approve
     and offer_id = p_offer_id;
  if not found then
    -- Nothing has been written yet, so returning here cannot tear anything.
    return jsonb_build_object('ok', false, 'reason', 'OFFER_CHANGED');
  end if;

  -- ── Past this point the offer is closed, so failures RAISE rather than return (same discipline
  --    as the approval RPC). Zero matching rows is a normal outcome, not a failure: an offer with
  --    no takers has nothing to supersede.
  update public.shift_claims
     set status = 'superseded'
   where shift_instance_id = p_shift_instance_id
     and user_id = p_owner
     and kind = 'pickup_request'
     and offer_id = p_offer_id
     and status = 'pending';
  get diagnostics v_superseded = row_count;

  return jsonb_build_object(
    'ok', true,
    'shift_instance_id', p_shift_instance_id,
    'employee_id', p_employee_id,
    'offer_id', p_offer_id,
    'superseded', v_superseded
  );
end;
$body$;

revoke execute on function public.lensed_cancel_shift_offer(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.lensed_cancel_shift_offer(uuid, uuid, uuid, uuid) to service_role;

commit;
