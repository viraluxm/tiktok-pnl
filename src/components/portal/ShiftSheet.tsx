'use client';

import { useState } from 'react';
import type { PortalShift } from '@/lib/schedule/portalTypes';
import {
  relativeDayLabel, fmtShortDate, fmtRangeLA, fmtTimeLA, crossesMidnightLA, fmtHours, roleLabel, dowLong, laDateOf, firstNameOf,
} from '@/lib/schedule/portalModel';
import { Sheet, FactBox, Button, InlineError } from './ui';
import { usePortalAction } from './PortalProvider';

// Detail sheet for one of MY shifts, and the two transfer actions that start from it.
//
// THE RULE the copy repeats: Drop Shift OFFERS the shift; the employee stays responsible until a
// coworker picks it up AND a manager approves. That sentence is in the confirm step and again in
// the offered state — never behind a tooltip.

type Step = 'view' | 'drop' | 'cancel-offer' | 'cancel-trade';

export function ShiftFacts({ shift, big }: { shift: PortalShift; big?: boolean }) {
  const overnight = crossesMidnightLA(shift.starts_at, shift.ends_at);
  return (
    <div>
      <p className={`${big ? 'text-2xl' : 'text-lg'} font-semibold tabular-nums tracking-tight text-tt-text`}>{fmtRangeLA(shift.starts_at, shift.ends_at)}</p>
      <p className="mt-0.5 text-[13px] text-tt-muted">
        {roleLabel(shift.role)}{shift.role ? ' · ' : ''}{fmtHours(shift.hours)}
        {overnight && ` · ends ${dowLong(laDateOf(shift.ends_at))} ${fmtTimeLA(shift.ends_at)}`}
      </p>
    </div>
  );
}

export function ShiftSheet({
  shift, todayISO, nowMs, open, onClose, onRequestTrade,
}: {
  shift: PortalShift | null;
  todayISO: string;
  nowMs: number;
  open: boolean;
  onClose: () => void;
  onRequestTrade: (shift: PortalShift) => void;
}) {
  const [step, setStep] = useState<Step>('view');
  const [err, setErr] = useState<string | null>(null);
  const drop = usePortalAction((c, id: string) => c.offer(id));
  const cancelOffer = usePortalAction((c, id: string, offerId: string) => c.cancelOffer(id, offerId));
  const cancelTrade = usePortalAction((c, id: string) => c.cancelTrade(id));

  const close = () => { setStep('view'); setErr(null); onClose(); };
  if (!shift) return null;

  const started = Date.parse(shift.starts_at) <= nowMs;
  const offered = shift.offer_state === 'offered';
  const trade = shift.trade;
  const canTransfer = !started && !offered && !trade;
  const title = `${relativeDayLabel(shift.shift_date, todayISO)} · ${fmtShortDate(shift.shift_date)}`;

  async function run(p: Promise<unknown>) {
    setErr(null);
    try { await p; close(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <Sheet open={open} onClose={close} title={step === 'view' ? title : step === 'drop' ? 'Drop this shift?' : step === 'cancel-offer' ? 'Cancel this offer?' : 'Cancel this trade?'}>
      <FactBox><ShiftFacts shift={shift} big /></FactBox>

      {step === 'view' && (
        <>
          {offered && (
            <div className="mb-4 rounded-xl border border-tt-yellow/30 bg-tt-yellow/[0.06] px-4 py-3">
              <p className="text-sm font-semibold text-tt-yellow">Offered · still yours</p>
              <p className="mt-1 text-[13px] leading-snug text-tt-text">
                You are still responsible for this shift until another employee picks it up and a manager approves the pickup.
              </p>
            </div>
          )}
          {trade && (
            <div className="mb-4 rounded-xl border border-tt-yellow/30 bg-tt-yellow/[0.06] px-4 py-3">
              <p className="text-sm font-semibold text-tt-yellow">Trade pending with {firstNameOf(trade.with_name)}</p>
              <p className="mt-1 text-[13px] leading-snug text-tt-text">
                {trade.status === 'pending_coworker'
                  ? trade.i_am === 'requester' ? `Waiting for ${firstNameOf(trade.with_name)} to answer.` : 'Waiting for your answer in Requests.'
                  : 'Both of you agreed. A manager decides next. This shift is yours until then.'}
              </p>
            </div>
          )}
          {started && !offered && !trade && (
            <p className="mb-4 text-[13px] text-tt-muted">This shift has {Date.parse(shift.ends_at) <= nowMs ? 'ended' : 'started'}, so it can no longer be dropped or traded.</p>
          )}
          {shift.status === 'claimed' && !offered && !trade && (
            <p className="mb-4 text-[13px] text-tt-muted">You picked this shift up.</p>
          )}

          <div className="flex flex-col gap-2">
            {offered && (
              <Button variant="quiet" size="lg" full onClick={() => setStep('cancel-offer')}>Cancel Offer</Button>
            )}
            {trade && trade.i_am === 'requester' && (
              <Button variant="quiet" size="lg" full onClick={() => setStep('cancel-trade')}>Cancel Trade Request</Button>
            )}
            {canTransfer && (
              <>
                <Button variant="quiet" size="lg" full onClick={() => { onRequestTrade(shift); close(); }}>Request Trade</Button>
                <Button variant="quiet" size="lg" full onClick={() => setStep('drop')}>Drop Shift</Button>
              </>
            )}
          </div>
        </>
      )}

      {step === 'drop' && (
        <>
          <p className="text-sm text-tt-muted">Your shift will be offered to eligible coworkers.</p>
          <p className="mt-2 text-sm font-medium leading-snug text-tt-text">
            You are still responsible for this shift until another employee picks it up and a manager approves the change.
          </p>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-5 flex gap-2">
            <Button variant="quiet" size="lg" className="flex-1" onClick={() => setStep('view')} disabled={drop.isPending}>Keep Shift</Button>
            <Button variant="primary" size="lg" className="flex-1" busy={drop.isPending} onClick={() => run(drop.mutateAsync([shift.id]))}>Drop Shift</Button>
          </div>
        </>
      )}

      {step === 'cancel-offer' && (
        <>
          <p className="text-sm text-tt-muted">You will stay scheduled for this shift. Any pending pickup requests will be cancelled.</p>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-5 flex gap-2">
            <Button variant="quiet" size="lg" className="flex-1" onClick={() => setStep('view')} disabled={cancelOffer.isPending}>Keep Offering</Button>
            <Button variant="primary" size="lg" className="flex-1" busy={cancelOffer.isPending} onClick={() => run(cancelOffer.mutateAsync([shift.id, shift.offer_id ?? '']))}>Cancel Offer</Button>
          </div>
        </>
      )}

      {step === 'cancel-trade' && trade && (
        <>
          <p className="text-sm text-tt-muted">{firstNameOf(trade.with_name)} will see the request was withdrawn. Both shifts stay exactly as they are.</p>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-5 flex gap-2">
            <Button variant="quiet" size="lg" className="flex-1" onClick={() => setStep('view')} disabled={cancelTrade.isPending}>Back</Button>
            <Button variant="primary" size="lg" className="flex-1" busy={cancelTrade.isPending} onClick={() => run(cancelTrade.mutateAsync([trade.id]))}>Cancel Trade</Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
