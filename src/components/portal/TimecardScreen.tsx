'use client';

import { useState } from 'react';
import type { PortalSnapshot, TimecardDay, TimecardEntry } from '@/lib/schedule/portalTypes';
import {
  fmtHours, fmtDuration, fmtTimeLA, fmtMonthDay, dowShort, dowLong, dayNumber, laDateOf, relativeDayLabel, fmtShortDate,
} from '@/lib/schedule/portalModel';
import { teamOfRole } from '@/lib/timeclock';
import { useTimecard } from './PortalProvider';
import { SectionLabel, Segmented, EmptyState, ErrorState, Skeleton } from './ui';
import { ChevronLeft, ClockIcon } from './icons';

// WORKED HOURS — the employee's own timecard, READ-ONLY (there is no write route for any of it).
//
// Three quantities, kept apart on purpose (migration 137):
//   CLOCK IN / CLOCK OUT  the attendance record, exactly as punched — never edited to move payroll
//   CLOCKED               what that punch spans, net of unpaid break
//   APPROVED              what payroll pays, as confirmed by a manager
// For a live host the approved figure is normally the verified live time and therefore SHORTER
// than clocked. Saying so plainly is the difference between "my hours were cut" and "my live time
// was approved". Nothing here is final until a manager confirms it, so an unconfirmed punch shows
// its attendance and says "Awaiting approval" instead of a number.

// The extra line under a row. 'awaiting_confirmation' and 'in_progress' are deliberately absent:
// the Approved and Clock out cells already say "Awaiting approval" and "In progress", and repeating
// them below was the one thing on this screen that read as filler.
function stateWords(e: TimecardEntry): { text: string; tone: string } | null {
  switch (e.state) {
    case 'auto_closed': return { text: 'Auto-closed — check the clock-out time with your manager', tone: 'text-tt-yellow' };
    case 'awaiting_confirmation':
    case 'in_progress': return null;
    default: return e.source === 'manual' ? { text: 'Entered by a manager', tone: 'text-tt-muted' } : null;
  }
}

function Figure({ label, children, dim }: { label: string; children: React.ReactNode; dim?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-tt-muted">{label}</p>
      <p className={`text-[15px] font-semibold tabular-nums ${dim ? 'text-tt-muted' : 'text-tt-text'}`}>{children}</p>
    </div>
  );
}

function Entry({ e, isHost }: { e: TimecardEntry; isHost: boolean }) {
  const outDay = e.clock_out ? laDateOf(e.clock_out) : null;
  const crosses = outDay != null && outDay !== e.date;
  const sw = stateWords(e);
  // A live host whose approved time is genuinely shorter than their punch gets the one sentence
  // that explains why — only then, so it never appears as boilerplate on every row.
  const showLiveNote = isHost && e.payable && e.approved_minutes != null && e.approved_minutes / 60 < e.clocked_hours - 0.01;

  return (
    <div className="py-3">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Figure label="Clock in">{fmtTimeLA(e.clock_in)}</Figure>
        <Figure label="Clock out">
          {e.clock_out ? (
            <>
              {fmtTimeLA(e.clock_out)}
              {crosses && <span className="ml-1 text-[11px] font-medium text-tt-muted">{dowShort(outDay as string)}</span>}
            </>
          ) : (
            <span className="font-medium text-tt-green">In progress</span>
          )}
        </Figure>
        <Figure label="Clocked" dim>{e.clock_out ? fmtDuration(e.clocked_hours) : '—'}</Figure>
        <Figure label="Approved">
          {e.clock_out == null
            ? '—'
            : e.payable
              ? fmtDuration(e.hours)
              : <span className="text-[13px] font-medium text-tt-yellow">Awaiting approval</span>}
        </Figure>
      </div>
      {(crosses || e.break_minutes > 0) && (
        <p className="mt-1.5 text-[12px] text-tt-muted">
          {crosses && `Ends ${dowLong(outDay as string)}`}
          {crosses && e.break_minutes > 0 && ' · '}
          {e.break_minutes > 0 && `${e.break_minutes} min unpaid break`}
        </p>
      )}
      {showLiveNote && <p className="mt-0.5 text-[12px] text-tt-muted">Based on confirmed Live Host working time</p>}
      {sw && <p className={`mt-0.5 text-[12px] font-medium ${sw.tone}`}>{sw.text}</p>}
    </div>
  );
}

function DayBlock({ d, today, isHost }: { d: TimecardDay; today: string; isHost: boolean }) {
  return (
    <section aria-label={fmtShortDate(d.date)} className="flex gap-3">
      <span className={`w-11 shrink-0 pt-3 text-center ${d.date === today ? 'text-tt-cyan' : 'text-tt-muted'}`}>
        <span className="block text-[10px] font-bold tracking-wide">{dowShort(d.date)}</span>
        <span className="block text-lg font-semibold leading-tight tabular-nums">{dayNumber(d.date)}</span>
      </span>
      <div className="min-w-0 flex-1 divide-y divide-white/[0.05] border-b border-white/[0.06]">
        {d.entries.map((e) => <Entry key={e.id} e={e} isHost={isHost} />)}
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
  // teamOfRole is the app's one role normalisation (kiosk picker, Team schedule, PayView).
  const isHost = teamOfRole(snap.employee.role) === 'host';

  return (
    <div>
      <button type="button" onClick={onBack} className="-ml-2 mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-[13px] font-semibold text-tt-muted hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
        <ChevronLeft size={16} /> Home
      </button>
      <h1 className="mb-1 text-[22px] font-semibold tracking-tight text-tt-text">Worked hours</h1>
      <p className="mb-5 text-[13px] text-tt-muted">Your attendance record and the hours approved for payroll. Scheduled hours are on Home.</p>

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
              <p className="mt-0.5 text-[12px] text-tt-muted">approved{tc.data.week.pendingHours > 0 ? ` · ${fmtHours(tc.data.week.pendingHours)} awaiting approval` : ` · ${fmtMonthDay(tc.data.week.start)} – ${fmtMonthDay(tc.data.week.end)}`}</p>
            </div>
            <div className="pl-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">This pay period</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-tt-text">{fmtHours(tc.data.period.workedHours)}</p>
              <p className="mt-0.5 text-[12px] text-tt-muted">approved · {fmtMonthDay(tc.data.period.start)} – {fmtMonthDay(tc.data.period.end)}{tc.data.period.pendingHours > 0 ? ` · +${fmtHours(tc.data.period.pendingHours)} pending` : ''}</p>
            </div>
          </div>

          <Segmented<'week' | 'period'> label="Range" value={range} onChange={setRange} options={[{ value: 'week', label: 'This week' }, { value: 'period', label: 'Pay period' }]} />

          <div className="mt-5">
            <SectionLabel>{range === 'week' ? 'Your days this week' : `Your days ${fmtMonthDay(tc.data.period.start)} – ${fmtMonthDay(tc.data.period.end)}`}</SectionLabel>
            {win && win.days.length === 0 ? (
              <EmptyState title={range === 'week' ? 'No worked time this week yet' : 'No worked time this pay period yet'} body="Clock-ins show up here after you clock out." />
            ) : (
              <div className="space-y-4">{win?.days.map((d) => <DayBlock key={d.date} d={d} today={today} isHost={isHost} />)}</div>
            )}
          </div>

          {/* WHAT THE NUMBER MEANS. A <details> keeps it one quiet line until someone asks — the
              alternative was a permanent paragraph of policy above the hours people came to read. */}
          <details className="mt-8 rounded-xl border border-tt-border bg-white/[0.02] px-4 py-3">
            <summary className="cursor-pointer list-none text-[13px] font-semibold text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
              About approved hours
            </summary>
            <p className="mt-2 text-[13px] leading-relaxed text-tt-muted">
              Approved hours are the hours your manager confirmed for payroll. For Live Hosts they are normally
              based on verified live-session time, so they can be shorter than the time between your clock-in and
              clock-out. Your clock-in and clock-out are kept exactly as you punched them, as your attendance record.
            </p>
          </details>

          <p className="mt-4 text-center text-[13px] text-tt-muted">Something look wrong? Contact your manager to request a correction.</p>
        </>
      )}
    </div>
  );
}
