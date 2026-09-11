'use client';

import { useMemo, useState } from 'react';
import { buildCalendarDays } from '@/lib/schedule/calendarModel';
import DayPeopleModal from '@/components/employees/weekly/DayPeopleModal';
import PendingConfirmModal from '@/components/employees/weekly/PendingConfirmModal';
import {
  HALEY_SINGLE,
  JUAN_AFTERNOON,
  JUAN_AFTERNOON_OPEN,
  JUAN_MORNING,
  PREVIEW_DATE,
  PREVIEW_DAYS,
  PREVIEW_EMPLOYEES,
  PREVIEW_SCHEDULED,
  PREVIEW_TODAY,
  type PreviewPunch,
} from './fixtures';

// THE REAL Shifts day modal and confirm queue, over local state.
//
// DayPeopleModal, PendingConfirmModal and buildCalendarDays are the production modules — there is
// no fork here, so what is approved on this page is what ships. Only the DATA is local: an
// in-memory array of punches instead of a Supabase query, and Confirm mutates that array instead
// of calling the RPC.
//
// ZERO DATABASE PATH: no Supabase client, no fetch, no RPC, no server action.

type Scenario = 'both-pending' | 'first-done-second-open' | 'one-confirmed' | 'single-shift';

const SCENARIOS: { key: Scenario; label: string; blurb: string }[] = [
  { key: 'both-pending', label: 'Two completed sessions, both pending', blurb: 'The case that used to collapse — 6:00–10:00 and 2:00–6:00, each awaiting confirmation.' },
  { key: 'first-done-second-open', label: 'First completed, second still open', blurb: 'Morning finished and pending; afternoon still on the clock.' },
  { key: 'one-confirmed', label: 'Morning confirmed, afternoon still pending', blurb: 'Confirming one must not hide or alter the other.' },
  { key: 'single-shift', label: 'An ordinary one-shift day', blurb: 'The regression check: unchanged from before.' },
];

const CONFIRMED_AT = '2026-09-16T01:00:00.000Z';

function seedFor(s: Scenario): PreviewPunch[] {
  switch (s) {
    case 'both-pending':
      return [JUAN_MORNING, JUAN_AFTERNOON, HALEY_SINGLE];
    case 'first-done-second-open':
      return [JUAN_MORNING, JUAN_AFTERNOON_OPEN, HALEY_SINGLE];
    case 'one-confirmed':
      return [{ ...JUAN_MORNING, confirmed_at: CONFIRMED_AT }, JUAN_AFTERNOON, HALEY_SINGLE];
    case 'single-shift':
      return [JUAN_MORNING, HALEY_SINGLE];
  }
}

function Counter({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-lg border border-tt-border bg-white/[0.02] px-3 py-2">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-tt-muted">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums text-tt-text">{value}</div>
      <div className="mt-0.5 text-[10px] leading-snug text-tt-muted">{note}</div>
    </div>
  );
}

export default function ShiftsDayPreview() {
  const [scenario, setScenario] = useState<Scenario>('both-pending');
  const [punches, setPunches] = useState<PreviewPunch[]>(() => seedFor('both-pending'));
  const [showQueue, setShowQueue] = useState(false);
  const [showDay, setShowDay] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function pick(s: Scenario) {
    setScenario(s);
    setPunches(seedFor(s));
    setNote(null);
  }

  const byDate = useMemo(
    () =>
      buildCalendarDays({
        employees: PREVIEW_EMPLOYEES,
        punches,
        scheduled: PREVIEW_SCHEDULED,
        days: PREVIEW_DAYS,
        view: 'all',
        todayISO: PREVIEW_TODAY,
      }),
    [punches],
  );

  const cell = byDate.get(PREVIEW_DATE)!;
  const juan = cell.people.filter((p) => p.employee_id === 'e-juan');

  // The production confirm path with the network removed: stamp confirmed_at on THAT punch only.
  const onConfirm = async (shiftId: string, confirmed: boolean) => {
    setPunches((rows) =>
      rows.map((r) => (r.id === shiftId ? { ...r, confirmed_at: confirmed ? CONFIRMED_AT : null } : r)),
    );
    setNote(`${confirmed ? 'Confirmed' : 'Unconfirmed'} ${shiftId} — the other records are untouched.`);
  };
  const onEdit = (shiftId: string) => setNote(`Edit requested for ${shiftId} (no editor in this preview).`);

  return (
    <div className="min-h-dvh bg-tt-bg px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold text-tt-text">Shifts day &amp; confirm queue — review</h1>
          <p className="mt-1 max-w-3xl text-sm text-tt-muted">
            The real day modal and confirm queue, running on fixture punches. Juan worked{' '}
            <span className="text-tt-text">two separate sessions</span> on Tuesday Sep 15. Before the
            fix the calendar kept only one per person-day, so the afternoon session never reached
            this queue — and a time-clock record that cannot be confirmed cannot be paid. Nothing on
            this page can reach the database.
          </p>
        </header>

        <div className="mb-4 flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => pick(s.key)}
              className={`rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${
                scenario === s.key
                  ? 'border-tt-cyan/50 bg-tt-cyan/10 text-tt-text'
                  : 'border-tt-border text-tt-muted hover:bg-tt-card-hover'
              }`}
            >
              <span className="block font-semibold">{s.label}</span>
              <span className="block text-[10.5px] text-tt-muted">{s.blurb}</span>
            </button>
          ))}
        </div>

        {note && (
          <div className="mb-4 rounded-lg border border-tt-green/25 bg-tt-green/[0.06] px-3 py-2 text-[12px] text-tt-green">
            {note}
          </div>
        )}

        {/* The day-cell counters, spelled out — these are what the month grid renders. */}
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Counter label="Headcount" value={cell.headcount} note="distinct PEOPLE on the floor" />
          <Counter label="Clocked" value={cell.clockedCount} note="worked ENTRIES" />
          <Counter label="Pending" value={cell.pendingCount} note="entries awaiting confirmation" />
          <Counter label="Open" value={cell.openCount} note="still on the clock" />
        </div>

        <div className="mb-5 rounded-lg border border-tt-border px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">
            Juan&apos;s entries for {PREVIEW_DATE} — {juan.length}
          </div>
          <ul className="mt-2 space-y-1">
            {juan.map((p, i) => (
              <li key={`${p.punch?.id ?? 'none'}-${i}`} className="text-[12.5px] text-tt-text">
                <span className="font-semibold">{p.punch ? p.punch.id : 'no punch'}</span>{' '}
                <span className="tabular-nums">
                  {p.punch ? `${p.punch.start_time} → ${p.punch.end_time ?? 'still on the clock'}` : '—'}
                </span>{' '}
                · state <span className="font-semibold text-tt-cyan">{p.state}</span>
                {' · '}
                {p.punch ? `${p.punch.hours.toFixed(2)} hr` : '0.00 hr'}
                {' · '}
                {p.scheduled ? (
                  <span className="text-tt-muted">plan {p.scheduled.start_time}–{p.scheduled.end_time}</span>
                ) : (
                  <span className="text-tt-muted">no plan attached</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="mb-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowDay(true)}
            className="rounded-xl bg-tt-cyan px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-tt-cyan/90"
          >
            Open the day ({cell.clockedCount} clocked)
          </button>
          <button
            type="button"
            onClick={() => setShowQueue(true)}
            className="rounded-xl border border-tt-border px-4 py-2 text-xs font-semibold text-tt-text transition-colors hover:bg-tt-card-hover"
          >
            Open the confirm queue ({cell.pendingCount} to confirm)
          </button>
        </div>
      </div>

      {showDay && (
        <DayPeopleModal
          day={cell}
          dateLabel="Tuesday, September 15"
          onClose={() => setShowDay(false)}
          onConfirm={onConfirm}
          onEdit={onEdit}
          onAddShift={() => setNote('Add shift is out of scope for this review.')}
        />
      )}

      {showQueue && (
        <PendingConfirmModal
          byDate={byDate}
          monthLabel="September 2026"
          onClose={() => setShowQueue(false)}
          onConfirm={onConfirm}
          onEdit={onEdit}
        />
      )}
    </div>
  );
}
