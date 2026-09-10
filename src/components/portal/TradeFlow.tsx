'use client';

import { useMemo, useState } from 'react';
import type { PortalShift, TradeCoworkerOption, TradeShiftFacts } from '@/lib/schedule/portalTypes';
import { fmtShortDate, fmtRangeLA, fmtHours, relativeDayLabel, roleLabel, firstNameOf, crossesMidnightLA } from '@/lib/schedule/portalModel';
import { Sheet, FactBox, Button, Avatar, InlineError, Skeleton, EmptyState } from './ui';
import { ChevronLeft, ChevronRight, SwapVerticalIcon } from './icons';
import { usePortalAction, useTradeOptions } from './PortalProvider';

// Request Trade — a one-for-one swap, proposed in four taps:
//   (0) which of MY shifts, when the flow started from a coworker's row on Team;
//   (1) which coworker;  (2) which of their shifts;  (3) confirm.
// The coworker list and their shifts come from the server (trade-options), which has already
// applied every structural rule — same role, same owner, future, un-offered, not double-booked —
// so the picker never offers a swap the server would refuse. Sending files pending_coworker and
// moves nothing; the copy says so on the confirm step.

function Facts({ s, big }: { s: TradeShiftFacts; big?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{fmtShortDate(s.shift_date)}</p>
      <p className={`${big ? 'text-xl' : 'whitespace-nowrap text-[15px]'} font-semibold tabular-nums tracking-tight text-tt-text`}>
        {fmtRangeLA(s.starts_at, s.ends_at)}{crossesMidnightLA(s.starts_at, s.ends_at) && <span className="ml-1 text-xs text-tt-muted">+1d</span>}
      </p>
      <p className="text-[12px] text-tt-muted">{fmtHours(s.hours)}</p>
    </div>
  );
}

function ListButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
    >
      {children}
      <ChevronRight size={18} className="ml-auto shrink-0 text-tt-muted" />
    </button>
  );
}

export function TradeFlow({
  open, onClose, myShifts, startShift, preferCoworkerName, todayISO, nowMs,
}: {
  open: boolean;
  onClose: () => void;
  /** my tradeable candidates for step 0 (only used when startShift is null) */
  myShifts: PortalShift[];
  /** the shift the flow was started from, or null to ask first */
  startShift: PortalShift | null;
  /** when started from a coworker's row: pre-select them on step 1 if they are an option */
  preferCoworkerName?: string | null;
  todayISO: string;
  nowMs: number;
}) {
  // The parent mounts this component fresh for every trade (keyed), so plain initial state is the
  // reset; no effect needs to mirror props into state.
  const [mine, setMine] = useState<PortalShift | null>(startShift);
  // undefined = nothing chosen yet (fall back to the coworker tapped on Team, if they are an
  // option); null = explicitly cleared with Back; string = chosen.
  const [coworkerId, setCoworkerId] = useState<string | null | undefined>(undefined);
  const [theirs, setTheirs] = useState<TradeShiftFacts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const options = useTradeOptions(open && mine ? mine.id : null);
  const send = usePortalAction((c, a: string, b: string) => c.requestTrade(a, b));

  const coworker: TradeCoworkerOption | null = useMemo(() => {
    const list = options.data?.coworkers ?? [];
    if (coworkerId === undefined) return preferCoworkerName ? list.find((c) => c.name === preferCoworkerName) ?? null : null;
    if (coworkerId === null) return null;
    return list.find((c) => c.employee_id === coworkerId) ?? null;
  }, [options.data, coworkerId, preferCoworkerName]);
  const setCoworker = (c: TradeCoworkerOption | null) => setCoworkerId(c ? c.employee_id : null);

  const tradeable = useMemo(
    () => myShifts.filter((s) => Date.parse(s.starts_at) > nowMs && s.offer_state !== 'offered' && !s.trade),
    [myShifts, nowMs],
  );

  const step = done ? 4 : !mine ? 0 : !coworker ? 1 : !theirs ? 2 : 3;
  const titles = ['Which shift do you want to trade?', 'Trade with whom?', `Which of ${coworker ? firstNameOf(coworker.name) : 'their'}'s shifts?`, 'Send this trade request?', 'Request sent'];
  const back = () => {
    setErr(null);
    if (step === 3) setTheirs(null);
    else if (step === 2) setCoworker(null);
    else if (step === 1 && !startShift) setMine(null);
    else onClose();
  };

  async function submit() {
    if (!mine || !theirs) return;
    setErr(null);
    try { await send.mutateAsync([mine.id, theirs.instance_id]); setDone(true); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={titles[step]} wide>
      {step > 0 && step < 4 && (
        <button type="button" onClick={back} className="-ml-1 mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-[13px] font-semibold text-tt-muted hover:text-tt-text">
          <ChevronLeft size={16} /> Back
        </button>
      )}

      {step === 0 && (
        tradeable.length === 0
          ? <EmptyState title="Nothing to trade right now" body="Only upcoming shifts that are not offered or already in a trade can be traded." />
          : (
            <div className="-mx-3 divide-y divide-white/[0.05]">
              {tradeable.map((s) => (
                <ListButton key={s.id} onClick={() => setMine(s)}>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{relativeDayLabel(s.shift_date, todayISO)} · {fmtShortDate(s.shift_date)}</p>
                    <p className="text-[15px] font-semibold tabular-nums text-tt-text">{fmtRangeLA(s.starts_at, s.ends_at)}</p>
                  </div>
                </ListButton>
              ))}
            </div>
          )
      )}

      {step === 1 && (
        <>
          {mine && <FactBox><p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">You give</p><Facts s={{ instance_id: mine.id, shift_date: mine.shift_date, starts_at: mine.starts_at, ends_at: mine.ends_at, hours: mine.hours }} /></FactBox>}
          {options.isLoading && <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>}
          {options.error && <InlineError>{(options.error as Error).message}</InlineError>}
          {options.data && options.data.coworkers.length === 0 && (
            <EmptyState title="No one can take this shift right now" body={`Nobody in the ${roleLabel(mine?.role)} role has an upcoming shift that could be swapped for this one.`} />
          )}
          {options.data && options.data.coworkers.length > 0 && (
            <div className="-mx-3 divide-y divide-white/[0.05]">
              {options.data.coworkers.map((c) => (
                <ListButton key={c.employee_id} onClick={() => setCoworker(c)}>
                  <Avatar name={c.name} />
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-tt-text">{c.name}</p>
                    <p className="text-[12px] text-tt-muted">{c.shifts.length} shift{c.shifts.length === 1 ? '' : 's'} you could take</p>
                  </div>
                </ListButton>
              ))}
            </div>
          )}
        </>
      )}

      {step === 2 && coworker && (
        <div className="-mx-3 divide-y divide-white/[0.05]">
          {coworker.shifts.map((s) => (
            <ListButton key={s.instance_id} onClick={() => setTheirs(s)}>
              <Facts s={s} />
            </ListButton>
          ))}
        </div>
      )}

      {step === 3 && mine && coworker && theirs && (
        <>
          <div className="flex flex-col">
            <FactBox>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tt-muted">You give</p>
              <Facts s={{ instance_id: mine.id, shift_date: mine.shift_date, starts_at: mine.starts_at, ends_at: mine.ends_at, hours: mine.hours }} big />
            </FactBox>
            <div className="-my-1.5 flex justify-center"><SwapVerticalIcon size={18} className="text-tt-muted" /></div>
            <FactBox>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tt-muted">You get</p>
              <Facts s={theirs} big />
            </FactBox>
          </div>
          <p className="mt-1 text-sm leading-snug text-tt-text">
            {firstNameOf(coworker.name)} has to accept, then a manager approves. Nothing changes until both happen, and you can cancel before then.
          </p>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-5 flex gap-2">
            <Button variant="quiet" size="lg" className="flex-1" onClick={back} disabled={send.isPending}>Back</Button>
            <Button variant="primary" size="lg" className="flex-1" busy={send.isPending} onClick={submit}>Send Request</Button>
          </div>
        </>
      )}

      {step === 4 && coworker && (
        <>
          <p className="text-sm leading-snug text-tt-text">
            Waiting for {firstNameOf(coworker.name)}. You will see their answer under Requests, and your shift stays yours until a manager approves the trade.
          </p>
          <div className="mt-5"><Button variant="primary" size="lg" full onClick={onClose}>Done</Button></div>
        </>
      )}
    </Sheet>
  );
}
