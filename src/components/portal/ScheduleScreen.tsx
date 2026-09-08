'use client';

import { useMemo, useState } from 'react';
import type { AvailableItem, PortalShift, PortalSnapshot, PortalTeamShift } from '@/lib/schedule/portalTypes';
import {
  fmtRangeLA, fmtHours, roleLabel, dowShort, dayNumber, dowLong, fmtMonthDay, crossesMidnightLA, mondayOf, defaultSelectedDay,
  pickNextShift, inClockWindow, relativeDayLabel, fmtShortDate, firstNameOf,
} from '@/lib/schedule/portalModel';
import { addDaysISO } from '@/lib/schedule/timezone';
import { ClockControls } from '@/app/s/[token]/ClockControls';
import { WeekStrip } from './WeekStrip';
import { Segmented, EmptyState, ErrorState, Skeleton, Avatar, Sheet, FactBox, Button, InlineError } from './ui';
import { ChevronRight, MoonIcon } from './icons';
import { usePortalAction, usePortalClient, useWeek } from './PortalProvider';
import type { NavState, Segment } from './nav';

// SCHEDULE — My Shifts · Team · Available, one week strip shared by the first two.

function DayStamp({ date, today }: { date: string; today: string }) {
  const isToday = date === today;
  return (
    <span className={`w-11 shrink-0 text-center ${isToday ? 'text-tt-cyan' : date < today ? 'text-tt-muted/70' : 'text-tt-muted'}`}>
      <span className="block text-[10px] font-bold tracking-wide">{dowShort(date)}</span>
      <span className="block text-lg font-semibold leading-tight tabular-nums">{dayNumber(date)}</span>
    </span>
  );
}

function statusWords(s: PortalShift): { text: string; tone: 'yellow' | 'green' | 'muted' } {
  if (s.offer_state === 'offered') return { text: 'Offered · still yours', tone: 'yellow' };
  if (s.trade) return { text: s.trade.status === 'pending_manager' ? 'Trade · waiting for manager' : `Trade · waiting for ${s.trade.i_am === 'requester' ? firstNameOf(s.trade.with_name) : 'you'}`, tone: 'yellow' };
  if (s.status === 'claimed') return { text: 'Picked up', tone: 'green' };
  return { text: 'Scheduled', tone: 'muted' };
}
const TONE = { yellow: 'text-tt-yellow', green: 'text-tt-green', muted: 'text-tt-muted' } as const;

// ── My Shifts ─────────────────────────────────────────────────────────────────────────────────

function MyShiftsList({ shifts, released, today, nowMs, onOpen, snap, selected }: {
  shifts: PortalShift[]; released: PortalSnapshot['releasedByMe']; today: string; nowMs: number; onOpen: (s: PortalShift) => void; snap: PortalSnapshot; selected: string;
}) {
  const client = usePortalClient();
  if (shifts.length === 0 && released.length === 0) {
    return <EmptyState title="No shifts this week" body="Use the arrows above to look at another week." />;
  }
  const rows = [...shifts.map((s) => ({ kind: 'mine' as const, s })), ...released.map((r) => ({ kind: 'released' as const, r }))]
    .sort((a, b) => {
      const sa = a.kind === 'mine' ? a.s.starts_at : a.r.starts_at;
      const sb = b.kind === 'mine' ? b.s.starts_at : b.r.starts_at;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  return (
    <ul className="-mx-2 divide-y divide-white/[0.05]">
      {rows.map((row) => {
        if (row.kind === 'released') {
          const r = row.r;
          return (
            <li key={`rel-${r.id}`} className="flex items-center gap-3 px-2 py-3 opacity-80">
              <DayStamp date={r.shift_date} today={today} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold tabular-nums text-tt-text">{fmtRangeLA(r.starts_at, r.ends_at)}</p>
                <p className="text-[12px] font-medium text-tt-yellow">Released · waiting for someone to pick it up</p>
              </div>
            </li>
          );
        }
        const s = row.s;
        const st = statusWords(s);
        const clockable = !!client.token && inClockWindow(s, nowMs);
        return (
          <li key={s.id} className="px-2">
            <button
              type="button"
              onClick={() => onOpen(s)}
              aria-current={s.shift_date === selected ? 'true' : undefined}
              className={`flex w-full items-center gap-3 rounded-xl py-3 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 ${s.shift_date === selected ? 'bg-white/[0.05] px-2 -mx-2 w-[calc(100%+16px)]' : ''}`}
            >
              <DayStamp date={s.shift_date} today={today} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums text-tt-text">
                  {fmtRangeLA(s.starts_at, s.ends_at)}
                  {crossesMidnightLA(s.starts_at, s.ends_at) && <MoonIcon size={14} className="text-tt-muted" aria-label="overnight" />}
                </span>
                <span className="block text-[12px] text-tt-muted">
                  {roleLabel(s.role)}{s.role ? ' · ' : ''}{fmtHours(s.hours)}
                  <span className={`ml-2 font-medium ${TONE[st.tone]}`}>{st.text}</span>
                </span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-tt-muted" />
            </button>
            {clockable && (
              <div className="-mt-1 mb-2 pl-14">
                <ClockControls token={client.token as string} instanceId={s.id} workerName={snap.employee.name} workerId={snap.employee.shortId} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Team ──────────────────────────────────────────────────────────────────────────────────────

function TeamList({ days, today, availableById, onCoworker }: {
  days: { date: string; shifts: PortalTeamShift[] }[]; today: string; availableById: Map<string, AvailableItem>;
  onCoworker: (s: PortalTeamShift, a: AvailableItem | null) => void;
}) {
  const withPeople = days.filter((d) => d.shifts.length > 0);
  if (withPeople.length === 0) return <EmptyState title="Nobody is scheduled this week" />;
  return (
    <div className="space-y-6">
      {withPeople.map((d) => {
        const roles = new Set(d.shifts.map((s) => (s.role ?? '').toLowerCase()));
        const groups = roles.size > 1
          ? ['host', 'fulfillment', ''].map((r) => ({ key: r, label: r ? roleLabel(r) : 'Other', list: d.shifts.filter((s) => (s.role ?? '').toLowerCase() === r || (!r && !['host', 'fulfillment'].includes((s.role ?? '').toLowerCase()))) })).filter((g) => g.list.length > 0)
          : [{ key: 'all', label: '', list: d.shifts }];
        return (
          <section key={d.date} aria-label={dowLong(d.date)}>
            <h3 className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${d.date === today ? 'text-tt-cyan' : 'text-tt-muted'}`}>
              {d.date === today ? 'Today · ' : ''}{dowLong(d.date)} <span className="font-medium normal-case tracking-normal">· {fmtMonthDay(d.date)}</span>
            </h3>
            {groups.map((g) => (
              <div key={g.key} className="mt-2">
                {g.label && <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-tt-muted/80">{g.label}</p>}
                <ul className="-mx-2 divide-y divide-white/[0.05]">
                  {g.list.map((s) => {
                    const a = availableById.get(s.instance_id) ?? null;
                    const canAct = !s.is_me;
                    const inner = (
                      <>
                        <Avatar name={s.name} size="sm" ring={s.offered ? 'offered' : s.is_me ? 'me' : null} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[14px] ${s.is_me ? 'font-semibold text-tt-cyan' : 'font-medium text-tt-text'}`}>
                            {s.name}{s.is_me ? ' (you)' : ''}
                          </span>
                          {s.offered && (
                            <span className="block text-[12px] font-medium text-tt-yellow">
                              {a && !a.refusal && !a.requested ? 'Offered · you can pick it up' : a?.requested ? 'Offered · you requested it' : 'Offered'}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1 text-[13px] tabular-nums text-tt-muted">
                          {fmtRangeLA(s.starts_at, s.ends_at)}
                          {crossesMidnightLA(s.starts_at, s.ends_at) && <MoonIcon size={13} aria-label="overnight" />}
                        </span>
                        {canAct && <ChevronRight size={16} className="shrink-0 text-tt-muted/70" />}
                      </>
                    );
                    return (
                      <li key={s.instance_id}>
                        {canAct ? (
                          <button type="button" onClick={() => onCoworker(s, a)} className="flex w-full items-center gap-3 px-2 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 rounded-xl">
                            {inner}
                          </button>
                        ) : (
                          <div className="flex items-center gap-3 px-2 py-2.5">{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ── Available ─────────────────────────────────────────────────────────────────────────────────

function AvailableList({ items, today, onPick }: { items: AvailableItem[]; today: string; onPick: (a: AvailableItem) => void }) {
  if (items.length === 0) return <EmptyState title="No open shifts right now" body="When a coworker offers a shift, or a manager posts one, it shows up here." />;
  return (
    <ul className="-mx-2 divide-y divide-white/[0.05]">
      {items.map((a) => {
        const can = !a.refusal && !a.requested;
        const inner = (
          <>
            <DayStamp date={a.shift_date} today={today} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums text-tt-text">
                {fmtRangeLA(a.starts_at, a.ends_at)}
                {crossesMidnightLA(a.starts_at, a.ends_at) && <MoonIcon size={14} className="text-tt-muted" aria-label="overnight" />}
              </span>
              <span className="block text-[12px] text-tt-muted">
                {roleLabel(a.role)}{a.role ? ' · ' : ''}{fmtHours(a.hours)}{a.offered_by_name ? ` · ${a.kind === 'offer' ? 'offered' : 'released'} by ${a.offered_by_name}` : a.kind === 'open' ? ' · posted by a manager' : ''}
              </span>
              {a.requested && <span className="block text-[12px] font-medium text-tt-yellow">Pickup requested · waiting for manager approval</span>}
              {a.refusal && <span className="block text-[12px] text-tt-muted">{a.refusal}</span>}
            </span>
            {can && <span className="shrink-0 rounded-lg bg-tt-cyan/15 px-3 py-1.5 text-xs font-semibold text-tt-cyan">Pick Up</span>}
          </>
        );
        return (
          <li key={a.id}>
            {can ? (
              <button type="button" onClick={() => onPick(a)} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">{inner}</button>
            ) : (
              <div className="flex items-center gap-3 px-2 py-3 opacity-90">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PickupSheet({ item, today, open, onClose }: { item: AvailableItem | null; today: string; open: boolean; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'requested' | 'claimed' | 'pending_approval' | null>(null);
  const pickup = usePortalAction((c, id: string, offerId: string | null) => c.pickup(id, offerId));
  const claim = usePortalAction((c, id: string) => c.claim(id));
  const close = () => { setErr(null); setOutcome(null); onClose(); };
  if (!item) return null;
  const busy = pickup.isPending || claim.isPending;

  async function submit() {
    if (!item) return;
    setErr(null);
    try {
      if (item.kind === 'offer') { await pickup.mutateAsync([item.id, item.offer_id]); setOutcome('requested'); }
      else { const r = await claim.mutateAsync([item.id]); setOutcome(r.result); }
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <Sheet open={open} onClose={close} title={outcome ? (outcome === 'claimed' ? "It's yours" : 'Request sent') : 'Pick up this shift?'}>
      <FactBox>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-tt-muted">{relativeDayLabel(item.shift_date, today)} · {fmtShortDate(item.shift_date)}</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(item.starts_at, item.ends_at)}</p>
        <p className="mt-0.5 text-[13px] text-tt-muted">{roleLabel(item.role)}{item.role ? ' · ' : ''}{fmtHours(item.hours)}{item.offered_by_name ? ` · from ${item.offered_by_name}` : ''}</p>
      </FactBox>
      {!outcome ? (
        <>
          <p className="text-sm leading-snug text-tt-text">
            {item.kind === 'offer'
              ? `A manager must approve before this shift becomes yours. Until then it stays ${item.offered_by_name ? firstNameOf(item.offered_by_name) + "'s" : 'with its current owner'}.`
              : 'This shift is open. It becomes yours right away, unless it would put your week over 40 hours, in which case a manager approves it first.'}
          </p>
          {err && <div className="mt-3"><InlineError>{err}</InlineError></div>}
          <div className="mt-5 flex gap-2">
            <Button variant="quiet" size="lg" className="flex-1" onClick={close} disabled={busy}>Not now</Button>
            <Button variant="primary" size="lg" className="flex-1" busy={busy} onClick={submit}>{item.kind === 'offer' ? 'Request Pickup' : 'Pick Up Shift'}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm leading-snug text-tt-text">
            {outcome === 'claimed' ? 'The shift is on your schedule.' : outcome === 'requested' ? 'Waiting for manager approval. It is not yours until a manager approves it.' : 'Over 40 hours this week, so a manager has to approve it. It is not yours yet.'}
          </p>
          <div className="mt-5"><Button variant="primary" size="lg" full onClick={close}>Done</Button></div>
        </>
      )}
    </Sheet>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────────────────────

export function ScheduleScreen({
  snap, nav, go, nowMs, onOpenShift, onPick, onCoworker,
}: {
  snap: PortalSnapshot;
  nav: NavState;
  go: (patch: Partial<NavState>, mode?: 'push' | 'replace') => void;
  nowMs: number;
  onOpenShift: (s: PortalShift) => void;
  onPick: (a: AvailableItem) => void;
  onCoworker: (s: PortalTeamShift, a: AvailableItem | null) => void;
}) {
  const today = snap.todayISO;
  const weekStart = nav.week ?? mondayOf(today);
  const week = useWeek(weekStart);
  const tradeByInstance = useMemo(() => new Map(snap.upcoming.filter((s) => s.trade).map((s) => [s.id, s.trade])), [snap.upcoming]);
  const weekShifts = useMemo(
    () => (week.data?.days ?? []).flatMap((d) => (d.shift ? [{ ...d.shift, trade: tradeByInstance.get(d.shift.id) ?? null }] : [])),
    [week.data, tradeByInstance],
  );
  const shiftsByDate = useMemo(() => new Map(weekShifts.map((s) => [s.shift_date, s])), [weekShifts]);
  const availableById = useMemo(() => new Map(snap.available.map((a) => [a.id, a])), [snap.available]);
  const openCount = snap.available.filter((a) => !a.refusal && !a.requested).length;
  const next = pickNextShift(snap.upcoming, nowMs, today);
  const selected = nav.day ?? defaultSelectedDay(weekStart, today, new Set(shiftsByDate.keys()));
  const weekEnd = addDaysISO(weekStart, 6);
  const releasedInWeek = snap.releasedByMe.filter((r) => r.shift_date >= weekStart && r.shift_date <= weekEnd);

  const seg: Segment = nav.seg;
  const body = week.isLoading && !week.data
    ? <div className="space-y-3"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
    : week.error && !week.data
      ? <ErrorState message="Could not load this week." onRetry={() => week.refetch()} busy={week.isFetching} />
      : seg === 'mine'
        ? <MyShiftsList shifts={weekShifts} released={releasedInWeek} today={today} nowMs={nowMs} onOpen={onOpenShift} snap={snap} selected={selected} />
        : <TeamList days={week.data?.team ?? []} today={today} availableById={availableById} onCoworker={onCoworker} />;

  return (
    <div>
      <h1 className="mb-4 text-[22px] font-semibold tracking-tight text-tt-text">Schedule</h1>
      <Segmented<Segment>
        label="Schedule view"
        value={seg}
        onChange={(v) => go({ seg: v })}
        options={[{ value: 'mine', label: 'My Shifts' }, { value: 'team', label: 'Team' }, { value: 'open', label: 'Available', badge: openCount || undefined }]}
      />
      <div className="mt-5">
        {seg !== 'open' ? (
          <>
            <WeekStrip
              weekStart={weekStart}
              todayISO={today}
              selected={selected}
              shiftsByDate={shiftsByDate}
              nextShiftDate={next?.shift.shift_date ?? null}
              onSelect={(d) => go({ day: d }, 'replace')}
              onWeek={(w) => go({ week: w === mondayOf(today) ? null : w, day: null }, 'replace')}
            />
            <div className="mt-5">{body}</div>
          </>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-tt-muted">Shifts you can pick up. A coworker&apos;s offered shift stays theirs until a manager approves you.</p>
            <AvailableList items={snap.available} today={today} onPick={onPick} />
          </>
        )}
      </div>
    </div>
  );
}
