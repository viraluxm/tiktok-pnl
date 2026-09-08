'use client';

import { useState } from 'react';
import { DropShiftButton, CancelOfferButton } from '../../s/[token]/phase2Parts';
import TeamSchedule from '../../s/[token]/TeamSchedule';
import PickupRequestsPanel from '@/components/employees/PickupRequestsPanel';
import { fmtDateLA, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';
import type { AvailableShift } from '@/lib/schedule/offerPlan';
import type { TeamScheduleWeek } from '@/lib/schedule/teamSchedule';
import { INITIAL, type DemoState } from './fixtures';

// The interactive half of /preview/schedule-phase2.
//
// Everything here drives the REAL Phase 2 components through their `onPreview` seams, so the
// dialogs, copy, spacing and states are the shipping ones — there is no parallel design to keep in
// sync. Only Shell/Section/Card are re-declared, because those three are private layout wrappers
// inside the employee page (three class strings, not UI logic).
//
// ZERO NETWORK. No fetch, no Supabase client, no server action. Every control mutates `demo`.

const TOKEN = 'preview';   // never used for a request — the seams short-circuit before any fetch

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-screen max-w-md bg-tt-bg px-4 py-6 text-tt-text">{children}</main>;
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-tt-muted">{title}</h2>
      {subtitle && <p className="mb-2 text-xs text-tt-muted">{subtitle}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-tt-border bg-tt-card px-4 py-3">{children}</div>;
}
function Facts({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-tt-text">{fmtDateLA(startsAt)}</p>
      <p className="text-xs text-tt-muted">
        {fmtTimeRangeLA(startsAt, endsAt)}
        {isOvernight(startsAt, endsAt) && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
      </p>
    </div>
  );
}

type Tab = 'mine' | 'team' | 'manager';

export default function Phase2Preview() {
  const [demo, setDemo] = useState<DemoState>(INITIAL);
  const [tab, setTab] = useState<Tab>('mine');

  // ── the whole demo state machine, mirroring the real lifecycle ────────────────────────────────
  const drop = (id: string) => setDemo((d) => ({
    ...d,
    mine: d.mine.map((s) => (s.id === id ? { ...s, offer_state: 'offered', offer_id: `offer-${id}` } : s)),
    log: [`Carlos dropped ${fmtDateLA(d.mine.find((s) => s.id === id)!.starts_at)} — still his until approved`, ...d.log],
  }));

  const cancelOffer = (id: string) => setDemo((d) => ({
    ...d,
    mine: d.mine.map((s) => (s.id === id ? { ...s, offer_state: null, offer_id: null } : s)),
    // Cancelling closes the cycle AND supersedes that cycle's pending requests.
    requests: d.requests.filter((r) => r.shift_instance_id !== id),
    myPickupIds: d.myPickupIds.filter((x) => x !== id),
    log: ['Offer cancelled — Carlos stays scheduled, pending requests superseded', ...d.log],
  }));

  const requestPickup = (id: string) => setDemo((d) => {
    const a = d.available.find((x) => x.id === id);
    if (!a || d.myPickupIds.includes(id)) return d;
    return {
      ...d,
      myPickupIds: [...d.myPickupIds, id],
      requests: [{
        claim_id: `claim-${id}`, shift_instance_id: id, offer_id: a.offer_id,
        shift_date: a.shift_date, starts_at: a.starts_at, ends_at: a.ends_at,
        offered_by_name: a.offered_by_name ?? 'Carlos', requester_name: 'Juan',
      }, ...d.requests],
      log: ['Juan requested a pickup — pending, nothing assigned yet', ...d.log],
    };
  });

  const act = (claimId: string, action: 'approve' | 'decline') => setDemo((d) => {
    const r = d.requests.find((x) => x.claim_id === claimId);
    if (!r) return d;
    const rest = d.requests.filter((x) => x.claim_id !== claimId);
    if (action === 'decline') {
      return { ...d, requests: rest, myPickupIds: d.myPickupIds.filter((x) => x !== r.shift_instance_id),
        declined: [...d.declined, r.claim_id],
        log: [`Declined — ${r.offered_by_name} keeps the shift and the offer stays open`, ...d.log] };
    }
    return {
      ...d,
      requests: rest,
      // The transfer: assignment moves, offer becomes terminal, rivals for the same shift are gone.
      available: d.available.filter((a) => a.id !== r.shift_instance_id),
      mine: d.mine.map((s) => (s.id === r.shift_instance_id
        ? { ...s, offer_state: 'transferred', assigned_to: r.requester_name } : s)),
      myPickupIds: d.myPickupIds.filter((x) => x !== r.shift_instance_id),
      transferred: [...d.transferred, { ...r }],
      log: [`Approved — ${r.shift_instance_id} transferred from ${r.offered_by_name} to ${r.requester_name}`, ...d.log],
    };
  });

  // Team week rebuilt from state so an offered shift shows its badge and a transfer moves the name.
  const week: TeamScheduleWeek = {
    ...demo.week,
    days: demo.week.days.map((day) => ({
      ...day,
      shifts: day.shifts.map((s) => {
        const m = demo.mine.find((x) => x.id === s.instance_id);
        if (!m) return s;
        return { ...s, offered: m.offer_state === 'offered', name: m.assigned_to ?? s.name };
      }),
    })),
  };
  const available: AvailableShift[] = demo.available.map((a) => ({
    ...a,
    refusal: demo.myPickupIds.includes(a.id) ? 'ALREADY_REQUESTED' : a.refusal,
  }));

  const tabBtn = (t: Tab, label: string, badge?: number) => (
    <button
      key={t} type="button" onClick={() => setTab(t)}
      aria-current={tab === t ? 'page' : undefined}
      className={`flex-1 rounded-md px-2 py-2 text-center text-[11px] font-semibold transition-colors ${
        tab === t ? 'bg-white/10 text-tt-text' : 'text-tt-muted hover:text-tt-text'}`}
    >
      {label}
      {!!badge && <span className="ml-1 rounded-full bg-tt-cyan/20 px-1.5 py-0.5 text-[10px] font-bold text-tt-cyan">{badge}</span>}
    </button>
  );

  return (
    <Shell>
      <header className="mb-4">
        <h1 className="text-lg font-bold text-tt-text">Schedule Phase 2 — Preview</h1>
        <div className="mt-2 rounded-lg border border-tt-yellow/40 bg-tt-yellow/10 px-3 py-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-tt-yellow">
            Phase 2 Preview · Demo data only · No production changes
          </p>
          <p className="mt-0.5 text-[11px] text-tt-muted">
            Real Phase 2 components driven by local state. Nothing here reads or writes Supabase.
          </p>
        </div>
        <button
          type="button" onClick={() => { setDemo(INITIAL); setTab('mine'); }}
          className="mt-2 rounded-lg border border-tt-border px-3 py-1.5 text-xs font-semibold text-tt-text transition-colors hover:bg-tt-card-hover"
        >Reset Demo</button>
      </header>

      <div className="mb-6 flex gap-1 rounded-lg bg-white/5 p-0.5">
        {tabBtn('mine', 'My Schedule')}
        {tabBtn('team', 'Team Schedule', available.filter((a) => !a.refusal).length)}
        {tabBtn('manager', 'Manager', demo.requests.length)}
      </div>

      {tab === 'mine' && (
        <>
          {demo.myPickupIds.length > 0 && (
            <div className="mb-6 rounded-lg border border-tt-cyan/40 bg-tt-cyan/10 px-4 py-3">
              <p className="text-sm font-semibold text-tt-cyan">Pickup requested</p>
              <ul className="mt-1 space-y-0.5">
                {demo.myPickupIds.map((id) => {
                  const a = demo.available.find((x) => x.id === id);
                  return a ? <li key={id} className="text-xs text-tt-muted">{fmtDateLA(a.starts_at)} · {fmtTimeRangeLA(a.starts_at, a.ends_at)}</li> : null;
                })}
              </ul>
              <p className="mt-1.5 text-xs text-tt-muted">Waiting for manager approval — not yours until it&rsquo;s approved.</p>
            </div>
          )}
          <Section title="Your shifts" subtitle="Carlos · Fulfillment">
            {demo.mine.map((s) => (
              <Card key={s.id}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <Facts startsAt={s.starts_at} endsAt={s.ends_at} />
                  <div className="shrink-0">
                    {s.offer_state === 'offered' ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-tt-yellow">Offered · still yours</span>
                        <CancelOfferButton
                          token={TOKEN} instanceId={s.id} offerId={s.offer_id ?? ''}
                          startsAt={s.starts_at} endsAt={s.ends_at}
                          onPreview={() => cancelOffer(s.id)}
                        />
                      </div>
                    ) : s.offer_state === 'transferred' ? (
                      <span className="text-xs text-tt-green">Picked up by {s.assigned_to}</span>
                    ) : (
                      <DropShiftButton
                        token={TOKEN} instanceId={s.id}
                        startsAt={s.starts_at} endsAt={s.ends_at}
                        onPreview={() => drop(s.id)}
                      />
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </Section>
        </>
      )}

      {tab === 'team' && (
        <TeamSchedule
          token={TOKEN} week={week} available={available}
          todayISO={demo.todayISO} onPreviewPickup={requestPickup}
        />
      )}

      {tab === 'manager' && (
        <>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-tt-muted">Pickup requests</h2>
          {demo.requests.length === 0 && (
            <p className="mb-4 rounded-lg border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted">
              No pending requests. Drop a shift on My Schedule, then request it on Team Schedule.
            </p>
          )}
          <PickupRequestsPanel previewRequests={demo.requests} onPreviewAct={act} />

          {demo.transferred.length > 0 && (
            <div className="mt-4 rounded-lg border border-tt-green/40 bg-tt-green/10 px-4 py-3">
              <p className="text-sm font-semibold text-tt-green">Approved · transferred</p>
              {demo.transferred.map((r) => (
                <p key={r.claim_id} className="mt-0.5 text-xs text-tt-muted">
                  {fmtDateLA(r.starts_at)} · {r.offered_by_name} → <span className="font-semibold text-tt-text">{r.requester_name}</span>
                </p>
              ))}
            </div>
          )}
          {demo.declined.length > 0 && (
            <div className="mt-3 rounded-lg border border-tt-border bg-tt-card px-4 py-3">
              <p className="text-sm font-semibold text-tt-text">Declined</p>
              <p className="mt-0.5 text-xs text-tt-muted">
                {demo.declined.length} request{demo.declined.length === 1 ? '' : 's'} declined — the shift stays with its
                original owner and the offer remains open.
              </p>
            </div>
          )}
        </>
      )}

      {demo.log.length > 0 && (
        <section className="mt-8 border-t border-tt-border pt-4">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">What just happened (local state only)</h3>
          <ul className="mt-1.5 space-y-1">
            {demo.log.slice(0, 6).map((l, i) => (
              <li key={i} className="text-[11px] text-tt-muted">· {l}</li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}
