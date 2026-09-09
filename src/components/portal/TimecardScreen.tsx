'use client';

import { useState } from 'react';
import type { PortalSnapshot, TimecardDay, TimecardEntry } from '@/lib/schedule/portalTypes';
import {
  fmtHours, fmtDuration, fmtTimeLA, fmtMonthDay, dowShort, dayNumber, laDateOf, relativeDayLabel, fmtShortDate,
} from '@/lib/schedule/portalModel';
import { useTimecard } from './PortalProvider';
import { SectionLabel, Segmented, EmptyState, ErrorState, Skeleton } from './ui';
import { ChevronLeft, ClockIcon } from './icons';

// WORKED HOURS — the employee's own timecard, read-only. Every number here is payroll's number:
// paidShiftHours over isPayableShift rows. Unconfirmed punches are shown and labelled, never
// folded into the total; an open punch says "in progress"; an auto-closed punch says so.

function stateWords(e: TimecardEntry): { text: string; tone: string } | null {
  switch (e.state) {
    case 'awaiting_confirmation': return { text: 'Awaiting manager confirmation', tone: 'text-tt-yellow' };
    case 'auto_closed': return { text: 'Auto-closed — check the clock-out time with your manager', tone: 'text-tt-yellow' };
    case 'in_progress': return { text: 'In progress', tone: 'text-tt-green' };
    default: return e.source === 'manual' ? { text: 'Entered by a manager', tone: 'text-tt-muted' } : null;
  }
}

function Entry({ e }: { e: TimecardEntry }) {
  const outDay = e.clock_out ? laDateOf(e.clock_out) : null;
  const crosses = outDay != null && outDay !== e.date;
  const sw = stateWords(e);
  const lbl = 'text-[10px] font-semibold uppercase tracking-wider text-tt-muted';
  return (
    <div className="py-3">
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
        <div>
          <p className={lbl}>Clock in</p>
          <p className="text-[15px] font-semibold tabular-nums text-tt-text">{fmtTimeLA(e.clock_in)}</p>
        </div>
        <div>
          <p className={lbl}>Clock out</p>
          <p className="text-[15px] font-semibold tabular-nums text-tt-text">
            {e.clock_out ? (
              <>
                {fmtTimeLA(e.clock_out)}
                {crosses && <span className="ml-1 text-[11px] font-medium text-tt-muted">{dowShort(outDay as string)}</span>}
              </>
            ) : (
              <span className="font-medium text-tt-green">In progress</span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className={lbl}>Worked</p>
          <p className={`text-[15px] font-semibold tabular-nums ${e.payable ? 'text-tt-text' : 'text-tt-muted'}`}>{e.clock_out ? fmtDuration(e.hours) : '—'}</p>
        </div>
      </div>
      {e.break_minutes > 0 && <p className="mt-1 text-[12px] text-tt-muted">{e.break_minutes} min unpaid break</p>}
      {sw && <p className={`mt-0.5 text-[12px] font-medium ${sw.tone}`}>{sw.text}</p>}
    </div>
  );
}

function DayBlock({ d, today }: { d: TimecardDay; today: string }) {
  return (
    <section aria-label={fmtShortDate(d.date)} className="flex gap-3">
      <span className={`w-11 shrink-0 pt-3 text-center ${d.date === today ? 'text-tt-cyan' : 'text-tt-muted'}`}>
        <span className="block text-[10px] font-bold tracking-wide">{dowShort(d.date)}</span>
        <span className="block text-lg font-semibold leading-tight tabular-nums">{dayNumber(d.date)}</span>
      </span>
      <div className="min-w-0 flex-1 divide-y divide-white/[0.05] border-b border-white/[0.06]">
        {d.entries.map((e) => <Entry key={e.id} e={e} />)}
        {d.entries.length > 1 && (
          <p className="py-2 text-right text-[12px] text-tt-muted">Day total <span className="font-semibold text-tt-text">{fmtDuration(d.hours)}</span></p>
        )}
      </div>
    </section>
  );
}

export function TimecardScreen({ snap, onBack }: { snap: PortalSnapshot; onBack: () => void }) {
  const tc = useTimecard();
  const [range, setRange] = useState<'week' | 'period'>('week');
  const today = snap.todayISO;
  const win = tc.data ? (range === 'week' ? tc.data.week : tc.data.period) : null;

  return (
    <div>
      <button type="button" onClick={onBack} className="-ml-2 mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-[13px] font-semibold text-tt-muted hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
        <ChevronLeft size={16} /> Home
      </button>
      <h1 className="mb-1 text-[22px] font-semibold tracking-tight text-tt-text">Worked hours</h1>
      <p className="mb-5 text-[13px] text-tt-muted">From your clock-ins and clock-outs. Scheduled hours are on Home.</p>

      {tc.isLoading && !tc.data && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>}
      {tc.error && !tc.data && <ErrorState message="Could not load your hours." onRetry={() => tc.refetch()} busy={tc.isFetching} />}

      {tc.data && (
        <>
          {tc.data.open && (
            <div className="mb-5 flex items-start gap-3 rounded-2xl border border-tt-green/30 bg-tt-green/[0.06] px-4 py-3">
              <ClockIcon size={18} className="mt-0.5 shrink-0 text-tt-green" />
              <div>
                <p className="text-sm font-semibold text-tt-green">{tc.data.open.onBreak ? 'On break' : 'Clocked in'} · since {fmtTimeLA(tc.data.open.clockedInAt)}{laDateOf(tc.data.open.clockedInAt) !== today ? ` ${relativeDayLabel(laDateOf(tc.data.open.clockedInAt), today).toLowerCase()}` : ''}</p>
                <p className="mt-0.5 text-[13px] text-tt-text">In progress. It will show here once you clock out.</p>
                {tc.data.open.needsManualClose && <p className="mt-1 text-[13px] font-medium text-tt-yellow">This punch has been open a long time — a manager needs to close it with the real time.</p>}
              </div>
            </div>
          )}

          <div className="mb-6 grid grid-cols-2 divide-x divide-white/[0.08]">
            <div className="pr-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">This week</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtHours(tc.data.week.workedHours)}</p>
              <p className="mt-0.5 text-[12px] text-tt-muted">{tc.data.week.pendingHours > 0 ? `+ ${fmtHours(tc.data.week.pendingHours)} awaiting confirmation` : `${fmtMonthDay(tc.data.week.start)} – ${fmtMonthDay(tc.data.week.end)}`}</p>
            </div>
            <div className="pl-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">This pay period</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtHours(tc.data.period.workedHours)}</p>
              <p className="mt-0.5 text-[12px] text-tt-muted">{fmtMonthDay(tc.data.period.start)} – {fmtMonthDay(tc.data.period.end)}{tc.data.period.pendingHours > 0 ? ` · +${fmtHours(tc.data.period.pendingHours)} pending` : ''}</p>
            </div>
          </div>

          <Segmented<'week' | 'period'> label="Range" value={range} onChange={setRange} options={[{ value: 'week', label: 'This week' }, { value: 'period', label: 'Pay period' }]} />

          <div className="mt-5">
            <SectionLabel>{range === 'week' ? 'Clock-ins this week' : `Clock-ins ${fmtMonthDay(tc.data.period.start)} – ${fmtMonthDay(tc.data.period.end)}`}</SectionLabel>
            {win && win.days.length === 0 ? (
              <EmptyState title={range === 'week' ? 'No worked time this week yet' : 'No worked time this pay period yet'} body="Clock-ins show up here after you clock out." />
            ) : (
              <div className="space-y-4">{win?.days.map((d) => <DayBlock key={d.date} d={d} today={today} />)}</div>
            )}
          </div>

          <p className="mt-8 text-center text-[13px] text-tt-muted">Something look wrong? Contact your manager to request a correction.</p>
        </>
      )}
    </div>
  );
}
