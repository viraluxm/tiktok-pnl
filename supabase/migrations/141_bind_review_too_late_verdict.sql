-- 141_bind_review_too_late_verdict.sql
--
-- Split "dismiss" into the two things it actually means.
--
-- THE PROBLEM. bind_review_decisions.decision allowed exactly ONE value, 'keep_multi', whose
-- meaning is "this multi-unit order is NOT an error — they really bought two". But the queue also
-- shows over-binds on boxes that have already been packed or shipped, where Keep is withheld
-- because restocking a unit the customer already has would trade a COGS error for an inventory
-- one. Dismiss is the only action left on those rows — and filing them as 'keep_multi' records
-- the opposite of the truth. The buyer on the row that prompted this paid $9.00 for ONE Jumbo
-- Strawberry Squeeze and was sent two. That is an error; it is simply past fixing.
--
-- WHY IT MATTERS BEYOND WORDING. ~424 of the flagged orders are already packed or shipped, and they
-- carry real COGS overstatement with no correction path. If the team dismisses them all as
-- 'keep_multi', that population becomes indistinguishable from genuinely-two-item orders and can
-- never be counted again for a COGS-only cleanup. The verdict is the only place that distinction
-- can live.
--
--   keep_multi  the order is legitimate; stop showing it
--   too_late    it WAS an over-bind, but the units are committed — acknowledged, not excused
--
-- Both values still remove the row from the queue (the read excludes on the EXISTENCE of a
-- decision, not its value), so this changes no queue behaviour. It only makes the two populations
-- countable apart.
--
-- SAFE TO SWAP THE CONSTRAINT. bind_review_decisions holds ZERO rows (the one test row from
-- 2026-09-08 was deleted), so there is nothing to migrate, nothing to backfill, and no existing
-- value that could fail the new check. The table is not read during a live show and nothing on the
-- capture or order-sync path touches it, so the brief ACCESS EXCLUSIVE lock is inert here.
--
-- Class A. APPLIED to prod 2026-09-09.

begin;

set local lock_timeout = '3s';

alter table public.bind_review_decisions
  drop constraint bind_review_decisions_decision_check;

alter table public.bind_review_decisions
  add constraint bind_review_decisions_decision_check
  check (decision in ('keep_multi', 'too_late'));

comment on column public.bind_review_decisions.decision is
  'keep_multi = the multi-unit order is legitimate (they really bought two). '
  'too_late = it WAS an over-bind, but the units are already packed or shipped so it cannot be '
  'corrected — acknowledged, not excused. The verdict is DERIVED SERVER-SIDE in '
  '/api/member/audit/dismiss from the live pack state, never taken from the client, so a stale '
  'page cannot file the wrong one. Both values drop the row from the queue.';

commit;
