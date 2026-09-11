'use client';

import type { PayPeriodSummary, PortalSnapshot, TimecardDay, TimecardEntry, TimecardWindow } from '@/lib/schedule/portalTypes';
import {
  fmtHours, fmtDuration, fmtTimeLA, fmtPayday, fmtPeriodRange, fmtMonthDay, dowShort, dowLong, dayNumber,
  laDateOf, relativeDayLabel, fmtShortDate,
} from '@/lib/schedule/portalModel';
import { teamOfRole } from '@/lib/timeclock';
import { usePayPeriods, useTimecard, useTimecardPeriod } from './PortalProvider';
import { SectionLabel, EmptyState, ErrorState, Skeleton } from './ui';
import { ChevronLeft, ChevronRight, ClockIcon } from './icons';
import type { NavState } from './nav';

// HOURS — the employee's own record, READ-ONLY (there is no write route for any of it).
//
// The screen is organised by PAY PERIOD, because that is the unit the employee is actually asking
// about: what is approved so far, what is still waiting, and when they get paid for it. The week
// figure lives on Home, where it sits beside the scheduled week it should be compared against.
//
// Three quantities, kept apart on purpose (migration 137):
//   CLOCK IN / CLOCK OUT  the attendance record, exactly as punched — never edited to move payroll
//   CLOCKED               what that punch spans, net of unpaid break
//   APPROVED              what payroll pays, as confirmed by a manager
// For a live host the approved figure is normally the verified live time and therefore SHORTER
// than clocked. Saying so plainly is the difference between "my hours were cut" and "my live time
// was approved". Nothing is final until a manager confirms it, so an unconfirmed punch shows its
// attendance and says "Waiting for approval" rather than a 0 that would read as a lost shift.
//
// NO MONEY. Nothing on this screen — or in the payload behind it — carries a rate, a gross, an
// estimate or a net. And nothing says "Paid": Lensed derives the scheduled Pay Day from the period
// and stores no evidence that a payment happened, so the label stays honest at "Pay Day".

// The extra line under a row. 'awaiting_confirmation' and 'in_progress' are deliberately absent:
// the Approved and Clock out cells already say "Waiting for approval" and "In progress", and
// repeating them below was the one thing on this screen that read as filler.
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
              : <span className="text-[13px] font-medium text-tt-yellow">Waiting for approval</span>}
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

/**
 * The period block: window, the two hour figures, and the Pay Day.
 *
 * Laid out so nothing has to shrink on a 320px screen — the totals stack, and the Pay Day row
 * wraps its value under its label rather than truncating the one date the employee came to read.
 */
function PeriodSummaryBlock({ label, summary }: { label: string; summary: PayPeriodSummary }) {
  return (
    <div className="rounded-2xl border border-tt-border px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-cyan">{label}</p>
      <p className="mt-1 text-[15px] font-medium text-tt-text">{fmtPeriodRange(summary.start, summary.end)}</p>
      {/* A zero is a NUMBER where this card owes a STATE. "0 hrs approved" in 32px reads to a picker
          as "your hours were zeroed"; the honest reading is "nothing has been confirmed yet". So the
          figure appears only when there is a figure, and otherwise the card says so in words and
          quiets down. (PRODUCT.md: status is stated in words; numbers are stated once.) */}
      {summary.workedHours > 0 ? (
        <p className="mt-3 text-[clamp(26px,8vw,32px)] font-semibold leading-tight tracking-tight text-tt-text">
          <span className="tabular-nums">{fmtHours(summary.workedHours)}</span>{' '}
          <span className="text-[15px] font-medium text-tt-muted">approved</span>
        </p>
      ) : (
        <p className="mt-3 text-[17px] font-semibold leading-snug text-tt-text">No hours approved yet</p>
      )}
      {summary.pendingHours > 0 && (
        <p className="mt-1 text-[13px] font-medium text-tt-yellow">
          <span className="tabular-nums">{fmtHours(summary.pendingHours)}</span> waiting for approval
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-tt-border pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">Pay Day</span>
        <span className="text-[15px] font-semibold text-tt-text">{fmtPayday(summary.payday)}</span>
      </div>
    </div>
  );
}

function DaysList({ win, today, isHost, emptyTitle }: { win: TimecardWindow; today: string; isHost: boolean; emptyTitle: string }) {
  if (win.days.length === 0) return <EmptyState title={emptyTitle} body="Clock-ins show up here after you clock out." />;
  return <div className="space-y-4">{win.days.map((d) => <DayBlock key={d.date} d={d} today={today} isHost={isHost} />)}</div>;
}

/**
 * WHAT THE NUMBER MEANS. A <details> keeps it one quiet line until someone asks — the alternative
 * was a permanent paragraph of policy above the hours people came to read. The Live Host sentence
 * shows only to a live host, so the explanation stays about the reader's own pay.
 */
function ApprovedHoursNote({ isHost }: { isHost: boolean }) {
  return (
    <details className="mt-8 rounded-xl border border-tt-border bg-white/[0.02] px-4 py-3">
      <summary className="cursor-pointer list-none text-[13px] font-semibold text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
        What are approved hours?
      </summary>
      <p className="mt-2 text-[13px] leading-relaxed text-tt-muted">
        Approved hours are the hours your manager has confirmed for your pay period. Your clock-in and
        clock-out times are shown separately.
      </p>
      {isHost && (
        <p className="mt-2 text-[13px] leading-relaxed text-tt-muted">
          Live Host approved hours are normally based on confirmed live-working time.
        </p>
      )}
    </details>
  );
}

/** One row in Previous Pay Periods. Approved hours and the scheduled Pay Day — no dollar figure. */
function PeriodRow({ p, onOpen }: { p: PayPeriodSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-white/[0.06] py-3 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70"
      aria-label={`${fmtPeriodRange(p.start, p.end)} — ${fmtHours(p.workedHours)} approved, Pay Day ${fmtPayday(p.payday)}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-tt-text">{fmtPeriodRange(p.start, p.end)}</span>
        <span className="mt-0.5 block text-[13px] text-tt-muted">
          {/* Same rule as the summary block: a closed period the employee did not work says so,
              rather than repeating "0 hrs approved" down the column. */}
          {p.workedHours > 0
            ? <><span className="tabular-nums text-tt-text">{fmtHours(p.workedHours)}</span> approved</>
            : <span className="text-tt-text">No approved hours</span>}
          {p.pendingHours > 0 && <span className="text-tt-yellow"> · {fmtHours(p.pendingHours)} waiting</span>}
        </span>
        <span className="mt-0.5 block text-[12px] text-tt-muted">Pay Day · {fmtMonthDay(p.payday)}</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-tt-muted" />
    </button>
  );
}

function PreviousPeriods({ onOpen }: { onOpen: (start: string) => void }) {
  const q = usePayPeriods();
  return (
    <section className="mt-8" aria-label="Previous pay periods">
      <SectionLabel>Previous pay periods</SectionLabel>
      {q.isLoading && !q.data && <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>}
      {q.error && !q.data && <ErrorState message="Could not load your previous pay periods." onRetry={() => q.refetch()} busy={q.isFetching} />}
      {q.data && (q.data.periods.length === 0
        ? <EmptyState title="No previous pay periods yet" />
        : <div>{q.data.periods.map((p) => <PeriodRow key={p.start} p={p} onOpen={() => onOpen(p.start)} />)}</div>
      )}
    </section>
  );
}

/** A past pay period, opened from the list: the same block and the same daily records. */
function PeriodDetail({ start, today, isHost, onBack }: { start: string; today: string; isHost: boolean; onBack: () => void }) {
  const q = useTimecardPeriod(start);
  return (
    <div>
      <button type="button" onClick={onBack} className="-ml-2 mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-[13px] font-semibold text-tt-muted hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
        <ChevronLeft size={16} /> Hours
      </button>
      {q.isLoading && !q.data && <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>}
      {q.error && !q.data && <ErrorState message="Could not load that pay period." onRetry={() => q.refetch()} busy={q.isFetching} />}
      {q.data && (
        <>
          <h1 className="mb-4 text-[22px] font-semibold tracking-tight text-tt-text">{fmtPeriodRange(q.data.summary.start, q.data.summary.end)}</h1>
          <PeriodSummaryBlock label="Pay period" summary={q.data.summary} />
          <div className="mt-6">
            <SectionLabel>Your days</SectionLabel>
            <DaysList win={q.data.period} today={today} isHost={isHost} emptyTitle="No worked time in this pay period" />
          </div>
          <ApprovedHoursNote isHost={isHost} />
        </>
      )}
    </div>
  );
}

export function TimecardScreen({
  snap, nav, go, onBack,
}: {
  snap: PortalSnapshot;
  nav: NavState;
  go: (patch: Partial<NavState>, mode?: 'push' | 'replace') => void;
  onBack: () => void;
}) {
  const tc = useTimecard(nav.period === null);
  const today = snap.todayISO;
  // teamOfRole is the app's one role normalisation (kiosk picker, Team schedule, PayView).
  const isHost = teamOfRole(snap.employee.role) === 'host';

  // A past period is a screen of its own, reached from the list and left with Back — the URL
  // carries it (?tab=hours&period=…) so a back-swipe returns to the list, not out of the app.
  if (nav.period) {
    return <PeriodDetail start={nav.period} today={today} isHost={isHost} onBack={() => go({ period: null })} />;
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="-ml-2 mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-[13px] font-semibold text-tt-muted hover:text-tt-text focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/70">
        <ChevronLeft size={16} /> Home
      </button>
      <h1 className="mb-1 text-[22px] font-semibold tracking-tight text-tt-text">Hours</h1>
      <p className="mb-5 text-[13px] text-tt-muted">Your attendance record and the hours approved for payroll. Scheduled hours are on Home.</p>

      {tc.isLoading && !tc.data && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>}
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

          <PeriodSummaryBlock
            label="Current pay period"
            summary={{
              start: tc.data.period.start,
              end: tc.data.period.end,
              payday: tc.data.payday,
              workedHours: tc.data.period.workedHours,
              pendingHours: tc.data.period.pendingHours,
            }}
          />

          <div className="mt-6">
            <SectionLabel>Your days this pay period</SectionLabel>
            <DaysList win={tc.data.period} today={today} isHost={isHost} emptyTitle="No worked time this pay period yet" />
          </div>

          <PreviousPeriods onOpen={(start) => go({ period: start })} />

          <ApprovedHoursNote isHost={isHost} />

          <p className="mt-4 text-center text-[13px] text-tt-muted">Something look wrong? Contact your manager to request a correction.</p>
        </>
      )}
    </div>
  );
}
