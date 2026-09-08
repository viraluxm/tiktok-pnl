-- shift_instances offer-lifecycle constraints (migration 129, section 1).
--
-- The three CHECKs together must admit EXACTLY four row shapes — not-offered, offered,
-- transferred, closed — and nothing else. Every other shape is a bug that would be invisible
-- until it corrupted somebody's schedule.
\set QUIET on
set client_min_messages = notice;
delete from public.shift_claims;
delete from public.shift_instances;

do $$
declare
  alice uuid := 'e1111111-0000-4000-8000-000000000001';
  o uuid := gen_random_uuid();
begin
  -- ═══ THE FOUR ACCEPTED SHAPES ═══
  perform t_accept('shape: not-offered (all three NULL)',
    format('select mk(%L,%L)', alice, '2026-10-01'));
  perform t_accept('shape: offered, scheduled, owned, not released',
    format('select mk(%L,%L,''scheduled'',''offered'',%L,now())', alice, '2026-10-02', o));
  perform t_accept('shape: offered on a CLAIMED shift',
    format('select mk(%L,%L,''claimed'',''offered'',%L,now())', alice, '2026-10-03', gen_random_uuid()));
  perform t_accept('shape: transferred (terminal, history)',
    format('select mk(%L,%L,''claimed'',''transferred'',%L,now())', alice, '2026-10-04', gen_random_uuid()));
  perform t_accept('shape: closed (terminal, history)',
    format('select mk(%L,%L,''scheduled'',''closed'',%L,now())', alice, '2026-10-05', gen_random_uuid()));

  -- ═══ offer_state VOCABULARY ═══
  perform t_reject('vocab: offer_state=''bogus'' rejected',
    format('select mk(%L,%L,''scheduled'',''bogus'',%L,now())', alice, '2026-10-06', gen_random_uuid()),
    'shift_instances_offer_state_check');
  -- 'released' is a STATUS word, never an offer_state. Confusing the two vocabularies is the
  -- single most likely mistake a future edit could make here.
  perform t_reject('vocab: offer_state=''released'' (status word) rejected',
    format('select mk(%L,%L,''scheduled'',''released'',%L,now())', alice, '2026-10-07', gen_random_uuid()),
    'shift_instances_offer_state_check');
  perform t_reject('vocab: offer_state='''' (empty string) rejected',
    format('select mk(%L,%L,''scheduled'','''',%L,now())', alice, '2026-10-08', gen_random_uuid()),
    'shift_instances_offer_state_check');

  -- ═══ TRIPLE CONSISTENCY — all-or-nothing ═══
  -- A stray offer_id under a NULL offer_state is a row that looks un-offered to every query but
  -- carries the debris of a past cycle; an audit read cannot tell the two apart.
  perform t_reject('triple: state NULL + stray offer_id',
    format('select mk(%L,%L,''scheduled'',null,%L,null)', alice, '2026-10-09', gen_random_uuid()),
    'shift_instances_offer_triple_consistent');
  perform t_reject('triple: state NULL + stray offered_at',
    format('select mk(%L,%L,''scheduled'',null,null,now())', alice, '2026-10-10'),
    'shift_instances_offer_triple_consistent');
  perform t_reject('triple: transferred with offered_at NULL',
    format('select mk(%L,%L,''claimed'',''transferred'',%L,null)', alice, '2026-10-11', gen_random_uuid()),
    'shift_instances_offer_triple_consistent');
  perform t_reject('triple: closed with offer_id NULL',
    format('select mk(%L,%L,''scheduled'',''closed'',null,now())', alice, '2026-10-12'),
    'shift_instances_offer_triple_consistent');
  perform t_reject('triple: offered with offer_id NULL',
    format('select mk(%L,%L,''scheduled'',''offered'',null,now())', alice, '2026-10-13'),
    'shift_instances_offer_triple_consistent');

  -- ═══ offered_is_owned — THE LOAD-BEARING INVARIANT ═══
  -- "Offered" must still mean OWNED and CLOCK-ELIGIBLE. If any of these were accepted, an offered
  -- shift could become unworkable by its own owner — the exact inverse of the product rule.
  perform t_reject('owned: offered with employee_id NULL',
    format('select mk(null,%L,''scheduled'',''offered'',%L,now())', '2026-10-14', gen_random_uuid()),
    'shift_instances_offered_is_owned');
  perform t_reject('owned: offered with released_at NOT NULL',
    format('select mk(%L,%L,''scheduled'',''offered'',%L,now(),now())', alice, '2026-10-15', gen_random_uuid()),
    'shift_instances_offered_is_owned');
  perform t_reject('owned: offered on status=released',
    format('select mk(%L,%L,''released'',''offered'',%L,now())', alice, '2026-10-16', gen_random_uuid()),
    'shift_instances_offered_is_owned');
  perform t_reject('owned: offered on status=cancelled',
    format('select mk(%L,%L,''cancelled'',''offered'',%L,now())', alice, '2026-10-17', gen_random_uuid()),
    'shift_instances_offered_is_owned');
  perform t_reject('owned: offered on status=worked',
    format('select mk(%L,%L,''worked'',''offered'',%L,now())', alice, '2026-10-18', gen_random_uuid()),
    'shift_instances_offered_is_owned');
  perform t_reject('owned: offered on status=missed',
    format('select mk(%L,%L,''missed'',''offered'',%L,now())', alice, '2026-10-19', gen_random_uuid()),
    'shift_instances_offered_is_owned');

  -- ═══ TERMINAL STATES ARE DELIBERATELY UNCONSTRAINED ═══
  -- A transferred/closed offer is HISTORY. Constraining it would block a later cancel, release or
  -- reassignment of a shift that merely once carried an offer. These two must stay ACCEPTED.
  perform t_accept('terminal: closed on a cancelled shift is allowed',
    format('select mk(%L,%L,''cancelled'',''closed'',%L,now())', alice, '2026-10-20', gen_random_uuid()));
  perform t_accept('terminal: closed with employee_id NULL is allowed',
    format('select mk(null,%L,''released'',''closed'',%L,now())', '2026-10-21', gen_random_uuid()));
end $$;

select t_report('shift_instances offer constraints');
