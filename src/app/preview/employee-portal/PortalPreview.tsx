'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PortalProvider } from '@/components/portal/PortalProvider';
import { PortalApp } from '@/components/portal/PortalApp';
import PickupRequestsPanel from '@/components/employees/PickupRequestsPanel';
import TradeRequestsPanel from '@/components/employees/TradeRequestsPanel';
import { fmtDateLA, fmtTimeRangeLA } from '@/lib/schedule/format';
import { instanceHours } from '@/lib/schedule/hours';
import { fmtShortDate } from '@/lib/schedule/portalModel';
import {
  initialWorld, snapshotFor, weekFor, timecardFor, tradeOptionsFor, act, nameOf, timeOffConflicts,
  CARLOS, JUAN, type DemoWorld, type Mutation, type PortalClient,
} from './fixtures';

// The interactive half of /preview/employee-portal. ZERO NETWORK: the PortalClient below resolves
// every call from `world`, and every action is a pure DemoWorld → DemoWorld transition.

const DELAY = 350; // a believable round trip, so busy states are visible
const wait = () => new Promise((r) => setTimeout(r, DELAY));

export default function PortalPreview() {
  const [world, setWorld] = useState<DemoWorld>(initialWorld);
  // The client's query functions read the LATEST world at call time (they run from event handlers
  // and React Query, never during render), so mirror state into a ref after each commit.
  const worldRef = useRef(world);
  useEffect(() => { worldRef.current = world; }, [world]);
  const qc = useQueryClient();
  const [manager, setManager] = useState(false);

  // Apply a mutation, then bust the portal's cache so the real app refetches from the new world.
  const apply = useCallback(async (m: Mutation) => {
    await wait();
    let next: DemoWorld | null = null;
    // Throwing inside setState would be swallowed; run the mutation against the current ref first.
    next = m(worldRef.current);
    setWorld(next);
    await qc.invalidateQueries({ queryKey: ['portal', 'preview'] });
  }, [qc]);

  const client = useMemo<PortalClient>(() => ({
    scopeKey: 'preview',
    token: null,   // no QR clock UI in the preview — it needs a real token and a real station
    getSnapshot: async () => { await wait(); return snapshotFor(worldRef.current); },
    getWeek: async (start) => { await wait(); return weekFor(worldRef.current, start); },
    getTimecard: async () => { await wait(); return timecardFor(worldRef.current); },
    getTradeOptions: async (id) => { await wait(); return tradeOptionsFor(worldRef.current, id); },
    offer: (id) => apply(act.offer(id)),
    cancelOffer: (id) => apply(act.cancelOffer(id)),
    pickup: (id) => apply(act.pickup(id)),
    claim: async () => { await wait(); return { result: 'claimed' as const }; },
    requestTrade: (a, b) => apply(act.requestTrade(a, b)),
    respondTrade: (id, r) => apply(act.respondTrade(id, r)),
    cancelTrade: (id) => apply(act.cancelTrade(id)),
    requestTimeOff: (a, b, r) => apply(act.requestTimeOff(a, b, r)),
    withdrawTimeOff: (id) => apply(act.withdrawTimeOff(id)),
  }), [apply]);

  const viewer = nameOf(world, world.viewerId);
  const pendingPickups = world.pickups.filter((p) => p.status === 'pending').map((p) => {
    const i = world.instances.find((x) => x.id === p.shift_instance_id)!;
    return { claim_id: p.claim_id, shift_instance_id: i.id, offer_id: p.offer_id ?? '', shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, offered_by_name: nameOf(world, i.employee_id), requester_name: nameOf(world, p.claimed_by) };
  });
  const pendingTrades = world.trades.filter((t) => t.status === 'pending_manager').map((t) => {
    const a = world.instances.find((x) => x.id === t.requester_shift_instance_id)!;
    const b = world.instances.find((x) => x.id === t.target_shift_instance_id)!;
    const f = (i: typeof a) => ({ instance_id: i.id, shift_date: i.shift_date, starts_at: i.starts_at, ends_at: i.ends_at, hours: instanceHours(i.starts_at, i.ends_at) });
    return { trade_id: t.id, requester_name: nameOf(world, t.requester_employee_id), target_name: nameOf(world, t.target_employee_id), requester_shift: f(a), target_shift: f(b), coworker_responded_at: t.coworker_responded_at, created_at: t.created_at };
  });
  const pendingTimeOff = world.timeOff.filter((r) => r.status === 'pending');

  const chip = 'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors';

  return (
    <div className="portal-root min-h-dvh bg-tt-bg text-tt-text">
      {/* Review controls — NOT part of the product. Sticky, compact, out of the way. */}
      <div className="sticky top-0 z-[60] border-b border-tt-border bg-[rgba(15,15,15,0.95)] px-3 py-2 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-tt-magenta">Preview</span>
          <span className="text-[11px] text-tt-muted">Viewing as</span>
          {[CARLOS, JUAN].map((id) => (
            <button key={id} type="button" onClick={() => { setManager(false); void apply(act.setViewer(id)); }}
              className={`${chip} ${!manager && world.viewerId === id ? 'bg-tt-cyan text-black' : 'bg-white/[0.06] text-tt-text hover:bg-white/10'}`}>
              {nameOf(world, id).split(' ')[0]}
            </button>
          ))}
          <button type="button" onClick={() => setManager((m) => !m)} className={`${chip} ${manager ? 'bg-tt-cyan text-black' : 'bg-white/[0.06] text-tt-text hover:bg-white/10'}`}>
            Manager queue{pendingPickups.length + pendingTrades.length + pendingTimeOff.length > 0 ? ` · ${pendingPickups.length + pendingTrades.length + pendingTimeOff.length}` : ''}
          </button>
          <span className="mx-1 hidden h-4 w-px bg-white/10 sm:block" />
          <button type="button" onClick={() => void apply(act.toggleClockedIn())} className={`${chip} bg-white/[0.06] text-tt-text hover:bg-white/10`}>
            {world.clockedInAt ? 'Clock Carlos out' : 'Clock Carlos in'}
          </button>
          <button type="button" onClick={() => void apply(act.reset())} className={`${chip} bg-white/[0.06] text-tt-muted hover:bg-white/10 hover:text-tt-text`}>Reset</button>
        </div>
      </div>

      {manager ? (
        <main className="mx-auto max-w-3xl px-4 py-6">
          <h1 className="text-xl font-semibold">Manager queue</h1>
          <p className="mt-1 mb-5 text-sm text-tt-muted">The same PickupRequestsPanel and TradeRequestsPanel the Team → Shifts tab mounts, driven by this preview&apos;s world.</p>
          <div className="space-y-4">
            <PickupRequestsPanel previewRequests={pendingPickups} onPreviewAct={(id, action) => void apply(act.decidePickup(id, action))} />
            <TradeRequestsPanel previewTrades={pendingTrades} onPreviewAct={(id, action) => void apply(act.decideTrade(id, action))} />
            {pendingTimeOff.length > 0 && (
              <div className="rounded-[14px] border border-tt-yellow/30 bg-tt-yellow/[0.06] px-5 py-4">
                <p className="mb-3 text-sm font-semibold">Time-off requests</p>
                <ul className="space-y-2">
                  {pendingTimeOff.map((r) => {
                    const n = timeOffConflicts(world, r);
                    return (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">{nameOf(world, r.employee_id)} · {r.start_date === r.end_date ? fmtShortDate(r.start_date) : `${fmtShortDate(r.start_date)} – ${fmtShortDate(r.end_date)}`}</p>
                          {r.reason && <p className="text-xs text-tt-muted">{r.reason}</p>}
                          {n > 0 && <p className="text-xs font-semibold text-tt-yellow">Conflicts with {n} scheduled shift{n === 1 ? '' : 's'} — approving keeps {n === 1 ? 'it' : 'them'} on the schedule</p>}
                        </div>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void apply(act.decideTimeOff(r.id, 'approved'))} className="rounded-lg border border-tt-green/40 px-2.5 py-1.5 text-[11px] font-semibold text-tt-green hover:bg-tt-green/10">Approve</button>
                          <button type="button" onClick={() => void apply(act.decideTimeOff(r.id, 'denied'))} className="rounded-lg border border-tt-border px-2.5 py-1.5 text-[11px] font-semibold text-tt-muted hover:bg-tt-card-hover">Deny</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {pendingPickups.length + pendingTrades.length + pendingTimeOff.length === 0 && (
              <p className="rounded-lg border border-dashed border-tt-border px-4 py-8 text-center text-sm text-tt-muted">Nothing waiting for a manager. Switch to Carlos or Juan and make a request.</p>
            )}
          </div>
          {world.log.length > 0 && (
            <div className="mt-8">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tt-muted">What happened</p>
              <ul className="space-y-1 text-[13px] text-tt-muted">{world.log.slice(0, 8).map((l, i) => <li key={i}>· {l}</li>)}</ul>
            </div>
          )}
          <p className="mt-8 text-[12px] text-tt-muted">
            Shift facts render through the same formatters as production: e.g. {fmtDateLA(world.instances[0].starts_at)} · {fmtTimeRangeLA(world.instances[0].starts_at, world.instances[0].ends_at)}.
          </p>
        </main>
      ) : (
        <PortalProvider key={world.viewerId} client={client}>
          <PortalApp initialNav={{ tab: 'home', seg: 'mine', week: null, day: null }} />
        </PortalProvider>
      )}
      <span className="sr-only">Viewing as {viewer}</span>
    </div>
  );
}
