'use client';

import { useState } from 'react';
import type { PortalSnapshot, TimeOffView, TradeView } from '@/lib/schedule/portalTypes';
import {
  groupRequests, tradeStatusWords, timeOffStatusWords, pickupStatusWords, fmtShortDate, fmtRangeLA, fmtMonthDay, firstNameOf,
  crossesMidnightLA, type RequestItem, fmtHours,
} from '@/lib/schedule/portalModel';
import TimeOffCalendar from '@/app/s/[token]/TimeOffCalendar';
import { inclusiveDays } from '@/lib/schedule/timeOff';
import { SectionLabel, EmptyState, Sheet, FactBox, Button, InlineError } from './ui';
import { ChevronRight, SwapVerticalIcon } from './icons';
import { usePortalAction } from './PortalProvider';

// REQUESTS — everything the employee has asked for, or been asked, in one place:
// Needs your action → Pending → History. Status is a sentence in words, never a colour alone.

const TONE: Record<string, string> = {
  pending: 'text-tt-yellow', pending_coworker: 'text-tt-yellow', pending_manager: 'text-tt-yellow',
  approved: 'text-tt-green', declined: 'text-tt-muted', denied: 'text-tt-muted', cancelled: 'text-tt-muted', rejected: 'text-tt-muted', superseded: 'text-tt-muted',
};

function dateRange(a: string, b: string): string {
  return a === b ? fmtShortDate(a) : `${fmtMonthDay(a)} – ${fmtMonthDay(b)}`;
}

function Row({ item, onOpen }: { item: RequestItem; onOpen: (item: RequestItem) => void }) {
  let kind = ''; let title = ''; let status = ''; let tone = 'text-tt-muted'; let sub: string | null = null;
  if (item.kind === 'trade') {
    const t = item.trade;
    kind = 'Trade'; title = `with ${t.other_name}`; status = tradeStatusWords(t); tone = TONE[t.status];
    sub = `${fmtShortDate(t.my_shift.shift_date)} ${fmtRangeLA(t.my_shift.starts_at, t.my_shift.ends_at)} for ${fmtShortDate(t.their_shift.shift_date)} ${fmtRangeLA(t.their_shift.starts_at, t.their_shift.ends_at)}`;
  } else if (item.kind === 'time_off') {
    const r = item.request;
    kind = 'Time off'; title = dateRange(r.start_date, r.end_date); status = timeOffStatusWords(r); tone = TONE[r.status];
    sub = r.reason;
  } else if (item.kind === 'pickup') {
    const p = item.pickup;
    kind = 'Shift pickup'; title = `${fmtShortDate(p.shift_date)} · ${fmtRangeLA(p.starts_at, p.ends_at)}`; status = pickupStatusWords(p); tone = TONE[p.status];
  } else {
    const c = item.claim;
    kind = 'Shift claim'; title = `${fmtShortDate(c.shift_date)} · ${fmtRangeLA(c.starts_at, c.ends_at)}`; status = 'Over 40 hours · waiting for manager'; tone = TONE.pending;
    sub = c.projected_week_hours != null ? `Would bring your week to ${fmtHours(c.projected_week_hours)}` : null;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-tt-text"><span className="text-tt-muted">{kind} · </span>{title}</span>
        {sub && <span className="mt-0.5 block text-[12px] leading-snug text-tt-muted">{sub}</span>}
        <span className={`mt-0.5 block text-[12px] font-medium ${tone}`}>{status}</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-tt-muted" />
    </button>
  );
}

// ── Trade detail: accept / decline / cancel / read ────────────────────────────────────────────

function Side({ label, s }: { label: string; s: TradeView['my_shift'] }) {
  return (
    <FactBox>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{label}</p>
      <p className="mt-0.5 text-[12px] text-tt-muted">{fmtShortDate(s.shift_date)}</p>
      <p className="text-xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(s.starts_at, s.ends_at)}{crossesMidnightLA(s.starts_at, s.ends_at) && <span className="ml-1 text-sm text-tt-muted">+1d</span>}</p>
    </FactBox>
  );
}

function TradeSheet({ trade, open, onClose }: { trade: TradeView | null; open: boolean; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const respond = usePortalAction((c, id: string, r: 'accept' | 'decline') => c.respondTrade(id, r));
  const cancel = usePortalAction((c, id: string) => c.cancelTrade(id));
  const close = () => { setErr(null); onClose(); };
  if (!trade) return null;
  const who = firstNameOf(trade.other_name);
  const canAnswer = trade.direction === 'incoming' && trade.status === 'pending_coworker';
  const canCancel = trade.direction === 'outgoing' && (trade.status === 'pending_coworker' || trade.status === 'pending_manager');
  const busy = respond.isPending || cancel.isPending;
  const run = async (p: Promise<unknown>) => { setErr(null); try { await p; close(); } catch (e) { setErr((e as Error).message); } };
  return (
    <Sheet open={open} onClose={close} title={canAnswer ? `${who} wants to trade` : `Trade with ${who}`} wide>
      <div className="flex flex-col">
        <Side label={canAnswer ? `${who} gives` : 'You give'} s={canAnswer ? trade.their_shift : trade.my_shift} />
        <div className="-my-1.5 flex justify-center"><SwapVerticalIcon size={18} className="text-tt-muted" /></div>
        <Side label={canAnswer ? 'You give' : 'You get'} s={canAnswer ? trade.my_shift : trade.their_shift} />
      </div>
      <p className={`mt-3 text-sm font-medium ${TONE[trade.status]}`}>{tradeStatusWords(trade)}</p>
      {trade.decision_note && <p className="mt-1 text-[13px] text-tt-muted">Manager: {trade.decision_note}</p>}
      {canAnswer && (
        <p className="mt-2 text-[13px] leading-snug text-tt-text">If you accept, a manager still has to approve it. Both shifts stay where they are until then.</p>
      )}
      {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
      {canAnswer && (
        <div className="mt-5 flex gap-2">
          <Button variant="quiet" size="lg" className="flex-1" busy={respond.isPending && respond.variables?.[1] === 'decline'} disabled={busy} onClick={() => run(respond.mutateAsync([trade.id, 'decline']))}>Decline</Button>
          <Button variant="primary" size="lg" className="flex-1" busy={respond.isPending && respond.variables?.[1] === 'accept'} disabled={busy} onClick={() => run(respond.mutateAsync([trade.id, 'accept']))}>Accept</Button>
        </div>
      )}
      {canCancel && (
        <div className="mt-5"><Button variant="quiet" size="lg" full busy={cancel.isPending} onClick={() => run(cancel.mutateAsync([trade.id]))}>Cancel Trade Request</Button></div>
      )}
      {!canAnswer && !canCancel && <div className="mt-5"><Button variant="quiet" size="lg" full onClick={close}>Close</Button></div>}
    </Sheet>
  );
}

// ── Time off: request + detail ────────────────────────────────────────────────────────────────

export function TimeOffSheet({ earliest, open, onClose }: { earliest: string; open: boolean; onClose: () => void }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = usePortalAction((c, a: string, b: string, r: string) => c.requestTimeOff(a, b, r));
  const close = () => { setStart(''); setEnd(''); setReason(''); setErr(null); setSent(false); onClose(); };
  async function submit() {
    if (!start) { setErr('Pick the first day you need off.'); return; }
    setErr(null);
    try { await send.mutateAsync([start, end || start, reason]); setSent(true); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Sheet open={open} onClose={close} title={sent ? 'Request sent' : 'Request time off'} wide>
      {sent ? (
        <>
          <p className="text-sm leading-snug text-tt-text">
            {dateRange(start, end || start)} is pending manager approval. You will see the answer here and on Home.
          </p>
          <div className="mt-5"><Button variant="primary" size="lg" full onClick={close}>Done</Button></div>
        </>
      ) : (
        <>
          {earliest && <p className="mb-3 text-[13px] text-tt-muted">Schedules are built two weeks ahead, so the earliest day you can request is {fmtShortDate(earliest)}.</p>}
          <TimeOffCalendar earliest={earliest} start={start} end={end} onChange={(a, b) => { setStart(a); setEnd(b); }} />
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-tt-muted">Note for your manager (optional)</span>
            <input
              type="text" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. family trip"
              className="w-full min-h-11 appearance-none rounded-xl border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-base text-tt-text [-webkit-text-fill-color:var(--color-tt-text)] placeholder:text-tt-muted/60 focus:outline-none focus:ring-2 focus:ring-tt-cyan/50"
            />
          </label>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-4">
            <Button variant="primary" size="lg" full busy={send.isPending} disabled={!start} onClick={submit}>
              {start ? `Request ${inclusiveDays(start, end || start)} day${inclusiveDays(start, end || start) === 1 ? '' : 's'} off` : 'Submit Request'}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function TimeOffDetail({ r, open, onClose }: { r: TimeOffView | null; open: boolean; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const withdraw = usePortalAction((c, id: string) => c.withdrawTimeOff(id));
  const close = () => { setErr(null); onClose(); };
  if (!r) return null;
  return (
    <Sheet open={open} onClose={close} title="Time off">
      <FactBox>
        <p className="text-xl font-semibold tracking-tight text-tt-text">{dateRange(r.start_date, r.end_date)}</p>
        <p className="mt-0.5 text-[13px] text-tt-muted">{inclusiveDays(r.start_date, r.end_date)} day{inclusiveDays(r.start_date, r.end_date) === 1 ? '' : 's'}{r.reason ? ` · ${r.reason}` : ''}</p>
      </FactBox>
      <p className={`text-sm font-medium ${TONE[r.status]}`}>{timeOffStatusWords(r)}</p>
      {r.decision_note && <p className="mt-1 text-[13px] text-tt-muted">Manager: {r.decision_note}</p>}
      {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
      <div className="mt-5">
        {r.status === 'pending'
          ? <Button variant="quiet" size="lg" full busy={withdraw.isPending} onClick={async () => { setErr(null); try { await withdraw.mutateAsync([r.id]); close(); } catch (e) { setErr((e as Error).message); } }}>Withdraw Request</Button>
          : <Button variant="quiet" size="lg" full onClick={close}>Close</Button>}
      </div>
    </Sheet>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────────────────────

function Group({ label, items, onOpen }: { label: string; items: RequestItem[]; onOpen: (i: RequestItem) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-7" aria-label={label}>
      <SectionLabel>{label}</SectionLabel>
      <div className="-mx-2 divide-y divide-white/[0.05]">{items.map((it) => <Row key={it.key} item={it} onOpen={onOpen} />)}</div>
    </section>
  );
}

export function RequestsScreen({ snap }: { snap: PortalSnapshot }) {
  const groups = groupRequests(snap);
  const [openItem, setOpenItem] = useState<RequestItem | null>(null);
  const [timeOffOpen, setTimeOffOpen] = useState(false);
  const empty = groups.action.length + groups.pending.length + groups.history.length === 0;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-tt-text">Requests</h1>
        <Button variant="tinted" size="sm" onClick={() => setTimeOffOpen(true)}>Request time off</Button>
      </div>
      {empty ? (
        <EmptyState title="Nothing here yet" body="Time off, shift pickups and trades you ask for show up here, along with anything a coworker asks of you." />
      ) : (
        <>
          <Group label="Needs your action" items={groups.action} onOpen={setOpenItem} />
          <Group label="Pending" items={groups.pending} onOpen={setOpenItem} />
          <Group label="History" items={groups.history} onOpen={setOpenItem} />
        </>
      )}

      <TradeSheet trade={openItem?.kind === 'trade' ? openItem.trade : null} open={openItem?.kind === 'trade'} onClose={() => setOpenItem(null)} />
      <TimeOffDetail r={openItem?.kind === 'time_off' ? openItem.request : null} open={openItem?.kind === 'time_off'} onClose={() => setOpenItem(null)} />
      <Sheet open={openItem?.kind === 'pickup' || openItem?.kind === 'ot_claim'} onClose={() => setOpenItem(null)} title={openItem?.kind === 'ot_claim' ? 'Shift claim' : 'Shift pickup'}>
        {openItem?.kind === 'pickup' && (
          <>
            <FactBox>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{fmtShortDate(openItem.pickup.shift_date)}</p>
              <p className="text-xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(openItem.pickup.starts_at, openItem.pickup.ends_at)}</p>
            </FactBox>
            <p className={`text-sm font-medium ${TONE[openItem.pickup.status]}`}>{pickupStatusWords(openItem.pickup)}</p>
            {openItem.pickup.status === 'pending' && <p className="mt-1 text-[13px] text-tt-muted">Not yours until a manager approves it. The shift&apos;s current owner is still responsible for it.</p>}
          </>
        )}
        {openItem?.kind === 'ot_claim' && (
          <>
            <FactBox>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{fmtShortDate(openItem.claim.shift_date)}</p>
              <p className="text-xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(openItem.claim.starts_at, openItem.claim.ends_at)}</p>
            </FactBox>
            <p className="text-sm font-medium text-tt-yellow">Over 40 hours · waiting for manager</p>
            <p className="mt-1 text-[13px] text-tt-muted">A manager is reviewing this claim. It is not yours yet.</p>
          </>
        )}
        <div className="mt-5"><Button variant="quiet" size="lg" full onClick={() => setOpenItem(null)}>Close</Button></div>
      </Sheet>
      <TimeOffSheet earliest={snap.timeOffEarliest} open={timeOffOpen} onClose={() => setTimeOffOpen(false)} />
    </div>
  );
}
