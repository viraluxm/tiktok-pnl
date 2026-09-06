-- 129_schedule_phase2_offer_lifecycle.sql
--
-- ⚠️ NOT APPLIED. Design draft for review. This DB has NO migration ledger — migrations are applied
--    BY HAND and the repo file is the only record (see CONVENTIONS.md and 085's header).
--    ➜ RE-INSPECT THE LIVE SCHEMA BEFORE APPLYING. Prefix 129 was free across origin/main and every
--      local and remote branch at authoring time (125 was main's highest; 126/127/128 are the label
--      run; 202608161754 is the one timestamped file). Do NOT backfill a lower gap.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Phase 2 lets an employee OFFER a shift to coworkers ("Drop Shift") while REMAINING RESPONSIBLE
-- for it until a manager approves someone else. The existing schema cannot express that.
--
-- The only value meaning "on the offer board" is status='released', and every consumer defines that
-- as "nobody is responsible": release.ts nulls employee_id in the same statement that sets it, the
-- three clock gates reject the row twice over (status not in CLOCK_ELIGIBLE_STATUSES, and
-- released_at IS NOT NULL), and claim.ts refuses to claim anything whose status is not 'released'
-- with employee_id IS NULL. So "offered" and "still mine" are mutually exclusive today, which is
-- the exact inverse of the product rule.
--
-- Rather than overload status — which would silently change what six other call sites believe —
-- this adds a SEPARATE, ORTHOGONAL offer lifecycle. A shift keeps its normal assignment fields and
-- gains an offer marker alongside them. Nothing about the legacy release/claim path changes; it
-- stays exactly as it is for the OT flow and for any historical row.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PRODUCTION PREFLIGHT (read-only, run against live before authoring — all clear)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--   shift_claims                     0 rows  → every new CHECK/index is trivially satisfiable;
--                                              the `kind` default back-fills nothing; no duplicate
--                                              pending or approved pickups can already exist.
--   shift_instances                190 rows  → all status='scheduled'; 0 with released_at NOT NULL;
--                                              0 with employee_id IS NULL. Every row satisfies the
--                                              new offer CHECK with offer_state NULL.
--   name collisions                    none  → no offer%/kind column on either table, no index or
--                                              constraint named %offer%/%pickup%, and no function
--                                              named lensed_approve_shift_pickup.
--   size                shift_instances 176 kB / shift_claims 88 kB → ACCESS EXCLUSIVE for the
--                                              ALTERs and a brief SHARE for the index builds are
--                                              microseconds at this scale. CREATE INDEX is
--                                              deliberately NOT concurrent: the Management API
--                                              wraps statements in a transaction and CONCURRENTLY
--                                              fails there (see the note in 079's header).
--
-- ADDITIVE AND BACKWARD-COMPATIBLE. Every column is nullable or defaulted; no existing column,
-- constraint or index is dropped or narrowed; UNIQUE(employee_id, shift_date) is untouched.
-- Rolling back is `alter table ... drop column ...` plus `drop index/function`, with no data loss
-- beyond the Phase 2 offers themselves.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. OFFER LIFECYCLE ON shift_instances
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- offer_state vocabulary — the smallest set that expresses the lifecycle:
--   NULL         not offered. The overwhelming majority of rows, forever. Chosen over an 'none'
--                literal so every pre-existing row is already valid and no backfill is needed.
--   'offered'    live on the board. The shift is STILL OWNED and still clock-eligible for its
--                owner; this is the whole point of the migration.
--   'transferred' an approval moved the assignment to a coworker. Terminal.
--   'closed'     the offer ended without a transfer (manager stopped offering, or the shift was
--                cancelled/​passed). Terminal. Kept distinct from 'transferred' so the audit trail
--                can tell "someone took it" from "nobody did".
--
-- offer_id is the GENERATION id and the ABA guard. Re-offering the same shift mints a NEW uuid, so
-- a pickup request or approval carrying an older offer_id can never act on the newer offer. Every
-- Phase 2 write predicates on it. It is kept (not cleared) on a terminal state so the claim rows
-- that reference it stay meaningful.
alter table public.shift_instances
  add column if not exists offer_state text,
  add column if not exists offer_id    uuid,
  add column if not exists offered_at  timestamptz;

comment on column public.shift_instances.offer_state is
  'Phase 2 offer lifecycle, ORTHOGONAL to status. NULL | offered | transferred | closed. '
  'offer_state=''offered'' means the shift is on the pickup board AND STILL OWNED by employee_id — '
  'it does NOT imply status=''released''. The legacy release/claim path is unchanged.';
comment on column public.shift_instances.offer_id is
  'Generation id for the current/last offer cycle. A pickup request or approval must match it, so a '
  'stale request from an earlier cycle can never transfer a re-offered shift (the ABA guard).';
comment on column public.shift_instances.offered_at is
  'When the CURRENT offer cycle opened. Set with offer_state=''offered'', retained on terminal states.';

-- Vocabulary gate.
alter table public.shift_instances drop constraint if exists shift_instances_offer_state_check;
alter table public.shift_instances
  add constraint shift_instances_offer_state_check
  check (offer_state is null or offer_state in ('offered', 'transferred', 'closed'));

-- THE LOAD-BEARING INVARIANT. A live offer must be a normal, owned, active shift:
--   • offer_id / offered_at present      — without them the ABA guard and the UI have nothing to key on
--   • employee_id NOT NULL               — "still responsible" IS the product rule
--   • released_at IS NULL                — an offered shift must stay clock-eligible for its owner,
--                                          and all three clock gates reject a non-null released_at.
--                                          This also makes the legacy release path and the Phase 2
--                                          offer path mutually exclusive by construction.
--   • status in ('scheduled','claimed')  — the ACTIVE OWNED states. Verified against the post-hotfix
--                                          lifecycle: these are exactly CLOCK_ELIGIBLE_STATUSES
--                                          (src/lib/schedule/eligibility.ts), and 'claimed' is
--                                          genuinely clockable since the released_at hotfix (PR #217).
--                                          'released' is excluded on purpose — it means unowned.
--                                          worked/missed/cancelled are resolved days.
-- Terminal and NULL states are deliberately NOT constrained on employee_id/released_at/status: a
-- transferred or closed offer is history and must not block a later cancel, release or reassignment.
alter table public.shift_instances drop constraint if exists shift_instances_offered_is_owned;
alter table public.shift_instances
  add constraint shift_instances_offered_is_owned
  check (
    offer_state is distinct from 'offered'
    or (
      offer_id is not null
      and offered_at is not null
      and employee_id is not null
      and released_at is null
      and status in ('scheduled', 'claimed')
    )
  );

-- The three offer columns are ALL-OR-NOTHING. An earlier draft only required offer_id when
-- offer_state was set, which left two malformed shapes reachable:
--   • offer_state NULL with a stray offer_id/offered_at — a shift that looks un-offered to every
--     query but carries the debris of a past cycle, so an audit read cannot tell the two apart;
--   • offer_state 'transferred'/'closed' with offered_at NULL — history with no start time.
-- Neither is producible by the Phase 2 code, and there are no historical rows to grandfather (the
-- columns are new and every one of the 190 live rows will have all three NULL), so tightening this
-- is free. Combined with shift_instances_offered_is_owned below, the four accepted shapes are
-- exactly: not-offered, offered, transferred, closed — and nothing else.
alter table public.shift_instances drop constraint if exists shift_instances_offer_has_id;
alter table public.shift_instances drop constraint if exists shift_instances_offer_triple_consistent;
alter table public.shift_instances
  add constraint shift_instances_offer_triple_consistent
  check (
    (offer_state is null and offer_id is null and offered_at is null)
    or (offer_state is not null and offer_id is not null and offered_at is not null)
  );

-- The board reads "live offers for this owner"; partial so it costs nothing for the 99% NULL case.
create index if not exists idx_shift_instances_offered
  on public.shift_instances (user_id, shift_date)
  where offer_state = 'offered';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2. PICKUP REQUESTS ON shift_claims
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- shift_claims already carries the OT-claim flow. Phase 2 pickup requests share the table (one
-- manager queue, one approval surface) but are a DIFFERENT KIND with different rules, and `kind`
-- is what keeps them apart in every query, index and CHECK below.
--
-- DEFAULT 'ot_claim' is chosen so the column is back-fillable with no rewrite — and, verified in
-- preflight, there are zero existing rows to back-fill at all.
alter table public.shift_claims
  add column if not exists kind     text not null default 'ot_claim',
  add column if not exists offer_id uuid;

comment on column public.shift_claims.kind is
  'ot_claim = the legacy over-40h approval flow. pickup_request = a Phase 2 "Pick Up Shift" request '
  'against a specific offer cycle. The two are never mixed by any query, index or CHECK.';
comment on column public.shift_claims.offer_id is
  'For pickup_request: the shift_instances.offer_id cycle this request belongs to. Required for '
  'pickup_request, always NULL for ot_claim.';

alter table public.shift_claims drop constraint if exists shift_claims_kind_check;
alter table public.shift_claims
  add constraint shift_claims_kind_check
  check (kind in ('ot_claim', 'pickup_request'));

-- Widen the status vocabulary. Every legacy value is preserved verbatim; only 'superseded' is added.
--
-- 'superseded' exists because approving one pickup must close its competitors HONESTLY. Marking a
-- rival 'rejected' would be a lie the worker can see — adminShifts' notification says "wasn't
-- approved — it's back on the board", which is wrong on both counts for someone who simply lost a
-- race. 'superseded' says what actually happened.
alter table public.shift_claims drop constraint if exists shift_claims_status_check;
alter table public.shift_claims
  add constraint shift_claims_status_check
  check (status in ('auto_approved', 'pending', 'approved', 'rejected', 'superseded'));

-- A pickup request is always tied to a cycle; an OT claim never is.
alter table public.shift_claims drop constraint if exists shift_claims_pickup_has_offer;
alter table public.shift_claims
  add constraint shift_claims_pickup_has_offer
  check (
    (kind = 'pickup_request' and offer_id is not null)
    or (kind = 'ot_claim' and offer_id is null)
  );

-- NEVER auto-approve a pickup. Phase 2's product rule is that a manager decides every transfer, and
-- this is the enforcement that survives a future code change: the legacy claimShift auto-approve
-- branch physically cannot produce a pickup_request row.
alter table public.shift_claims drop constraint if exists shift_claims_pickup_never_auto;
alter table public.shift_claims
  add constraint shift_claims_pickup_never_auto
  check (kind <> 'pickup_request' or status <> 'auto_approved');

-- ── Uniqueness. BOTH scoped to pickup_request so the legacy OT flow is untouched. ──────────────
--
-- A. At most one effective winner per shift. This is the constraint that makes "only one approved
--    claimer" a database guarantee rather than an accident of statement ordering. Keyed on the
--    SHIFT, not the offer cycle: two different cycles must never both have produced a winner
--    either, since only one person can actually work the shift.
--    'auto_approved' is included for future-safety even though the CHECK above forbids it today —
--    a belt-and-braces pairing, not a contradiction.
create unique index if not exists idx_shift_claims_one_approved_pickup
  on public.shift_claims (shift_instance_id)
  where kind = 'pickup_request' and status in ('approved', 'auto_approved');

-- B. One live request per person per shift. Replaces the self-documented non-atomic check-then-
--    insert in claim.ts (its own TODO asks for exactly this index). Keyed on the SHIFT rather than
--    the offer cycle so a double-tap cannot file twice; a genuinely NEW cycle is reachable because
--    the previous cycle's requests are moved out of 'pending' when it closes.
create unique index if not exists idx_shift_claims_one_pending_pickup_per_employee
  on public.shift_claims (shift_instance_id, claimed_by)
  where kind = 'pickup_request' and status = 'pending';

-- Manager queue lookup.
create index if not exists idx_shift_claims_pending_pickup
  on public.shift_claims (user_id, shift_instance_id)
  where kind = 'pickup_request' and status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 3. TRANSACTIONAL APPROVAL
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Manager approval touches four things at once: the winning claim, every rival claim, the shift's
-- assignment, and the offer's terminal state. PostgREST gives single-statement atomicity only, so
-- doing this as separate writes permits exactly the two half-states the product must never show:
-- a claim approved with the assignment unmoved, or an assignment moved with rivals still pending
-- and — because the CAS pre-state is consumed — un-reapprovable forever.
--
-- SECURITY DEFINER + service_role only, matching lensed_kiosk_manual_punch_as and
-- lensed_reconcile_time_clock. The API layer still performs the admin/session authorization; this
-- function's job is the row-state CAS and the atomic multi-row write. p_owner is passed explicitly
-- and resolved server-side from the authenticated session — NEVER from client input — because
-- service_role has no auth.uid() to trust.
--
-- Every preconditon is a WHERE predicate, not a prior SELECT, so a row that changes underneath us
-- fails the CAS and returns a refusal instead of writing a torn state. Refusals are returned as a
-- jsonb {ok:false, reason} rather than raised, so the caller can map them to friendly copy; only
-- genuine faults raise.
create or replace function public.lensed_approve_shift_pickup(
  p_owner             uuid,
  p_shift_instance_id uuid,
  p_claim_id          uuid,
  p_offer_id          uuid
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
begin
  if p_owner is null then raise exception 'INVALID_OWNER'; end if;

  -- Serialize every approval for this shift, so two managers acting at once queue rather than race.
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
    -- than writing again.
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
  -- Row count IS checked: a predicate that matches nothing must never be mistaken for success.
  -- Unreachable in practice — the claim is held FOR UPDATE from the top of this function and was
  -- verified 'pending' there — so reaching it means the row changed under a held lock.
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

  return jsonb_build_object(
    'ok', true,
    'shift_instance_id', p_shift_instance_id,
    'employee_id', v_claim.claimed_by,
    'previous_employee_id', v_inst.employee_id,
    'offer_id', p_offer_id,
    'superseded', v_superseded
  );
end;
$body$;

-- Grants: service_role ONLY, matching every other lensed_* write RPC. Never anon, never
-- authenticated — the route resolves the owner from the session and calls this with the admin client.
revoke execute on function public.lensed_approve_shift_pickup(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.lensed_approve_shift_pickup(uuid, uuid, uuid, uuid) to service_role;

commit;
