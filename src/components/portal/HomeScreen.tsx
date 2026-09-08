'use client';

import { useMemo } from 'react';
import type { PortalShift, PortalSnapshot } from '@/lib/schedule/portalTypes';
import {
  greetingFor, laHourOf, fmtLongDate, pickNextShift, nextShiftHint, relativeDayLabel, fmtRangeLA, fmtHours, roleLabel,
  buildAlerts, inClockWindow, fmtTimeLA, fmtShortDate, crossesMidnightLA, fmtMonthDay, defaultSelectedDay, mondayOf, type Alert,
} from '@/lib/schedule/portalModel';
import { ClockControls } from '@/app/s/[token]/ClockControls';
import { WeekStrip } from './WeekStrip';
import { SectionLabel, Skeleton, ErrorState, Button } from './ui';
import { ChevronRight, ClockIcon } from './icons';
import { usePortalClient, useWeek } from './PortalProvider';
import type { NavState } from './nav';

// HOME — the five-second screen: who you are, when you work next, how many hours (scheduled AND
// worked, separately), which days this week, and anything waiting on you.

function AlertRow({ a, onGo }: { a: Alert; onGo: (a: Alert) => void }) {
  return (
    <button
      type="button"
      onClick={() => onGo(a)}
      className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 ${a.actionable ? 'bg-tt-cyan/[0.08]' : ''}`}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.actionable ? 'bg-tt-cyan' : 'bg-white/25'}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-tt-text">{a.title}</span>
        {a.body && <span className="mt-0.5 block text-[13px] leading-snug text-tt-muted">{a.body}</span>}
      </span>
      <ChevronRight size={18} className="mt-0.5 shrink-0 text-tt-muted" />
    </button>
  );
}

function StatusLine({ shift }: { shift: PortalShift }) {
  if (shift.offer_state === 'offered') return <p className="mt-2 text-[13px] font-medium text-tt-yellow">Offered · still yours until a manager approves a pickup</p>;
  if (shift.trade) return <p className="mt-2 text-[13px] font-medium text-tt-yellow">In a pending trade with {shift.trade.with_name.split(' ')[0]}</p>;
  return null;
}

export function HomeScreen({
  snap, nav, go, nowMs, onOpenShift, onOpenAvailable,
}: {
  snap: PortalSnapshot;
  nav: NavState;
  go: (patch: Partial<NavState>, mode?: 'push' | 'replace') => void;
  nowMs: number;
  onOpenShift: (s: PortalShift) => void;
  onOpenAvailable: () => void;
}) {
  const client = usePortalClient();
  const today = snap.todayISO;
  const weekStart = nav.week ?? mondayOf(today);
  const week = useWeek(weekStart);

  const tradeByInstance = useMemo(() => {
    const m = new Map<string, PortalShift['trade']>();
    for (const s of snap.upcoming) if (s.trade) m.set(s.id, s.trade);
    return m;
  }, [snap.upcoming]);
  const weekShifts = useMemo(
    () => (week.data?.days ?? []).flatMap((d) => (d.shift ? [{ ...d.shift, trade: tradeByInstance.get(d.shift.id) ?? null }] : [])),
    [week.data, tradeByInstance],
  );
  const shiftsByDate = useMemo(() => new Map(weekShifts.map((s) => [s.shift_date, s])), [weekShifts]);
  const next = pickNextShift(snap.upcoming, nowMs, today);
  const selected = nav.day ?? defaultSelectedDay(weekStart, today, new Set(shiftsByDate.keys()));
  const selectedShift = shiftsByDate.get(selected) ?? null;

  const alerts = buildAlerts(snap, nowMs);
  const actionable = alerts.filter((a) => a.actionable);
  const updates = alerts.filter((a) => !a.actionable);
  const onGo = (a: Alert) => (a.go.tab === 'requests' ? go({ tab: 'requests' }) : go({ tab: 'schedule', seg: a.go.seg }));
  const openCount = snap.available.filter((a) => !a.refusal && !a.requested).length;

  return (
    <div className="lg:grid lg:grid-cols-[1.1fr_1fr] lg:gap-10">
      <div>
        {/* Greeting */}
        <header className="mb-6">
          <p className="text-[13px] text-tt-muted">{fmtLongDate(today)}</p>
          <h1 className="mt-0.5 text-[26px] font-semibold leading-tight tracking-tight text-tt-text">
            {greetingFor(laHourOf(nowMs), snap.employee.name)} <span aria-hidden>👋</span>
          </h1>
          {snap.clock.state !== 'clocked_out' && snap.clock.clockedInAt && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-tt-green">
              <ClockIcon size={15} /> {snap.clock.state === 'on_break' ? 'On break' : 'Working'} · clocked in {fmtTimeLA(snap.clock.clockedInAt)}
            </p>
          )}
        </header>

        {actionable.length > 0 && (
          <section className="mb-6" aria-label="Needs your attention">
            <SectionLabel>Needs your attention</SectionLabel>
            <div className="-mx-3 flex flex-col gap-1">{actionable.map((a) => <AlertRow key={a.id} a={a} onGo={onGo} />)}</div>
          </section>
        )}

        {/* Next shift — the one elevated surface on Home */}
        <section className="mb-6" aria-label="Next shift">
          {next ? (
            <div className="rounded-2xl border border-tt-border bg-[#171717] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-cyan">
                {next.when === 'now' ? 'Working now' : 'Next shift'}
              </p>
              <button
                type="button"
                onClick={() => onOpenShift(next.shift)}
                className="mt-2 block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70 rounded-lg"
              >
                <p className="text-lg font-medium text-tt-text">
                  {relativeDayLabel(next.shift.shift_date, today)}
                  <span className="text-tt-muted">{next.when === 'later' ? `, ${fmtMonthDay(next.shift.shift_date)}` : ''}</span>
                </p>
                <p className="mt-1 whitespace-nowrap text-[clamp(24px,7.6vw,32px)] font-semibold leading-none tabular-nums tracking-tight text-tt-text md:text-[32px]">
                  {fmtRangeLA(next.shift.starts_at, next.shift.ends_at)}
                </p>
                <p className="mt-2 text-[13px] text-tt-muted">
                  {roleLabel(next.shift.role)}{next.shift.role ? ' · ' : ''}{fmtHours(next.shift.hours)}
                  {crossesMidnightLA(next.shift.starts_at, next.shift.ends_at) && ' · overnight'}
                  {nextShiftHint(next) && <span className="text-tt-text"> · {nextShiftHint(next)}</span>}
                </p>
                <StatusLine shift={next.shift} />
              </button>
              {client.token && inClockWindow(next.shift, nowMs) && (
                <div className="mt-3 border-t border-tt-border pt-3">
                  <ClockControls token={client.token} instanceId={next.shift.id} workerName={snap.employee.name} workerId={snap.employee.shortId} />
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-tt-border p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">Next shift</p>
              <p className="mt-2 text-lg font-medium text-tt-text">Nothing scheduled yet</p>
              <p className="mt-1 text-[13px] text-tt-muted">
                {openCount > 0 ? `${openCount} open shift${openCount === 1 ? '' : 's'} you could pick up.` : 'Your manager has not scheduled your next shift.'}
              </p>
              {openCount > 0 && <div className="mt-3"><Button variant="tinted" size="sm" onClick={onOpenAvailable}>See open shifts</Button></div>}
            </div>
          )}
        </section>

        {/* Hours — scheduled vs worked, two sources, side by side */}
        <section className="mb-8" aria-label="Hours this week">
          <SectionLabel>This week · {fmtMonthDay(snap.thisWeek.start)} – {fmtMonthDay(snap.thisWeek.end)}</SectionLabel>
          <div className="grid grid-cols-2 divide-x divide-white/[0.08]">
            <div className="pr-4">
              <p className="text-[13px] font-medium text-tt-muted">Scheduled</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtHours(snap.thisWeek.scheduledHours)}</p>
              <p className="mt-0.5 text-[12px] text-tt-muted">Planned shifts</p>
            </div>
            <button
              type="button"
              onClick={() => go({ tab: 'hours' })}
              className="group -my-1 rounded-r-xl py-1 pl-4 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
              aria-label="Worked this week — open your timecard"
            >
              <p className="flex items-center gap-1 text-[13px] font-medium text-tt-muted">
                Worked <ChevronRight size={14} className="text-tt-muted transition-transform group-hover:translate-x-0.5" />
              </p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtHours(snap.thisWeek.workedHours)}</p>
              <p className="mt-0.5 text-[12px] text-tt-muted">
                {snap.thisWeek.pendingHours > 0 ? `+ ${fmtHours(snap.thisWeek.pendingHours)} awaiting confirmation` : 'From your clock-ins'}
              </p>
            </button>
          </div>
        </section>
      </div>

      <div>
        {/* Week strip + selected day */}
        <section className="mb-8" aria-label="This week">
          <WeekStrip
            weekStart={weekStart}
            todayISO={today}
            selected={selected}
            shiftsByDate={shiftsByDate}
            nextShiftDate={next?.shift.shift_date ?? null}
            onSelect={(d) => go({ day: d }, 'replace')}
            onWeek={(w) => go({ week: w === mondayOf(today) ? null : w, day: null }, 'replace')}
          />
          <div className="mt-4 min-h-[76px]">
            {week.isLoading && !week.data ? (
              <div className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-56" /></div>
            ) : week.error && !week.data ? (
              <ErrorState message="Could not load this week." onRetry={() => week.refetch()} busy={week.isFetching} />
            ) : (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">
                  {relativeDayLabel(selected, today)}{relativeDayLabel(selected, today) !== fmtLongDate(selected) ? ` · ${fmtShortDate(selected)}` : ''}
                </p>
                {selectedShift ? (
                  <button
                    type="button"
                    onClick={() => onOpenShift(selectedShift)}
                    className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl py-2 text-left hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
                  >
                    <span>
                      <span className="block text-xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtRangeLA(selectedShift.starts_at, selectedShift.ends_at)}</span>
                      <span className="mt-0.5 block text-[13px] text-tt-muted">
                        {roleLabel(selectedShift.role)}{selectedShift.role ? ' · ' : ''}{fmtHours(selectedShift.hours)}
                        <span className={`ml-2 font-medium ${selectedShift.offer_state === 'offered' || selectedShift.trade ? 'text-tt-yellow' : 'text-tt-text/80'}`}>
                          {selectedShift.offer_state === 'offered' ? 'Offered · still yours' : selectedShift.trade ? 'Trade pending' : selectedShift.status === 'claimed' ? 'Picked up' : 'Scheduled'}
                        </span>
                      </span>
                    </span>
                    <ChevronRight size={18} className="shrink-0 text-tt-muted" />
                  </button>
                ) : (
                  <div className="mt-1 py-2">
                    <p className="text-lg font-medium text-tt-text">{selected === today ? "You're off today." : selected < today ? 'You were off.' : "You're off."}</p>
                    {openCount > 0 && selected >= today && (
                      <button type="button" onClick={onOpenAvailable} className="mt-1 inline-flex items-center gap-1 text-[13px] font-semibold text-tt-cyan hover:underline">
                        {openCount} open shift{openCount === 1 ? '' : 's'} available <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {updates.length > 0 && (
          <section className="mb-6" aria-label="Updates">
            <SectionLabel>Updates</SectionLabel>
            <div className="-mx-3 flex flex-col gap-0.5">{updates.map((a) => <AlertRow key={a.id} a={a} onGo={onGo} />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}
