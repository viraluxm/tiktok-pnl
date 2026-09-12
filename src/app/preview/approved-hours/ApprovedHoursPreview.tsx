'use client';

import { useMemo, useState } from 'react';
import { buildCalendarDays } from '@/lib/schedule/calendarModel';
import DayPeopleModal from '@/components/employees/weekly/DayPeopleModal';
import PendingConfirmModal from '@/components/employees/weekly/PendingConfirmModal';
import { approvedMinutesForTeam, formatApprovedMinutes } from '@/lib/shifts/approvedHours';
import { hoursToMinutes } from '@/lib/employees';
import {
  ADRIANA_CONFIRMED,
  ADRIANA_SHOW,
  CONFIRMED_AT,
  JUAN_DAY,
  MARISOL_AFTERNOON,
  MARISOL_LEGACY,
  MARISOL_MORNING,
  PREVIEW_DATE,
  PREVIEW_DAYS,
  PREVIEW_EMPLOYEES,
  PREVIEW_SCHEDULED,
  PREVIEW_TODAY,
  type PreviewPunch,
} from './fixtures';

// APPROVED HOURS ARE FOR LIVE HOSTS ONLY — the review page for that rule.
//
// DayPeopleModal, PendingConfirmModal, PersonCard and buildCalendarDays are the PRODUCTION
// modules. There is no fork of the tile here, so an Approved Hours box that does not appear on
// this page does not appear in the app either. Only the DATA is local.
//
// ZERO DATABASE PATH: no Supabase client, no fetch, no RPC, no server action, no real employee.
// Confirming mutates a useState array — and it mutates it through approvedMinutesForTeam(), the
// same write gate useShifts applies, so what this page records is what production would store.

type Scenario = 'side-by-side' | 'split-day' | 'host-confirmed' | 'legacy-row';

const SCENARIOS: { key: Scenario; label: string; blurb: string }[] = [
  { key: 'side-by-side', label: 'Fulfillment vs Live Host', blurb: 'Juan 6:00 AM–2:00 PM has no Approved fields. Adriana 4:00 PM–10:00 PM still does.' },
  { key: 'split-day', label: 'Two fulfillment shifts, one day', blurb: '6:00–10:00 and 2:00–6:00 — separate records, separate Confirm, no Approved fields on either.' },
  { key: 'host-confirmed', label: 'Live Host already confirmed', blurb: 'The approved figure and "Adjust approved hours" are unchanged for a host.' },
  { key: 'legacy-row', label: 'A legacy fulfillment override', blurb: 'Confirmed before this change: the stored figure is still shown, but can no longer be edited here.' },
];

function seedFor(s: Scenario): PreviewPunch[] {
  switch (s) {
    case 'side-by-side':
      return [JUAN_DAY, ADRIANA_SHOW];
    case 'split-day':
      return [MARISOL_MORNING, MARISOL_AFTERNOON, ADRIANA_SHOW];
    case 'host-confirmed':
      return [JUAN_DAY, ADRIANA_CONFIRMED];
    case 'legacy-row':
      return [MARISOL_LEGACY, ADRIANA_CONFIRMED];
  }
}

/** What paidShiftHours() would pay this row: the approved figure when set, else the clocked one. */
function payable(p: PreviewPunch, clockedHours: number): string {
  return p.approved_minutes != null
    ? `${formatApprovedMinutes(p.approved_minutes)} (approved)`
    : `${formatApprovedMinutes(hoursToMinutes(clockedHours))} (clocked)`;
}

export default function ApprovedHoursPreview() {
  const [scenario, setScenario] = useState<Scenario>('side-by-side');
  const [punches, setPunches] = useState<PreviewPunch[]>(() => seedFor('side-by-side'));
  const [showQueue, setShowQueue] = useState(false);
  const [showDay, setShowDay] = useState(true);
  const [log, setLog] = useState<string[]>([]);

  function pick(s: Scenario) {
    setScenario(s);
    setPunches(seedFor(s));
    setLog([]);
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
  const nameOf = (id: string) => PREVIEW_EMPLOYEES.find((e) => e.id === id)?.name ?? id;

  // THE PRODUCTION WRITE PATH with the network removed. The team gate is the real one: the tile
  // hands over the team it derived from the role, and approvedMinutesForTeam collapses a non-host
  // figure to null exactly as useShifts does before the RPC call.
  const onConfirm: React.ComponentProps<typeof DayPeopleModal>['onConfirm'] = async (
    shiftId, confirmed, team, approvedMinutes,
  ) => {
    const stored = confirmed ? approvedMinutesForTeam(team, approvedMinutes ?? null) : null;
    setPunches((rows) =>
      rows.map((r) => (r.id === shiftId
        ? {
          ...r,
          confirmed_at: confirmed ? r.confirmed_at ?? CONFIRMED_AT : null,
          // Mirrors the RPC: coalesce on confirm, cleared outright on unconfirm.
          approved_minutes: confirmed ? stored ?? r.approved_minutes ?? null : null,
        }
        : r)),
    );
    const who = nameOf(punches.find((r) => r.id === shiftId)?.employee_id ?? '');
    setLog((l) => [
      confirmed
        ? `Confirmed ${shiftId} (${who}, team "${team}") → p_approved_minutes = ${stored === null ? 'NULL' : stored}`
        : `Unconfirmed ${shiftId} (${who}) → approval cleared`,
      ...l,
    ]);
  };

  const onApprovedMinutes: React.ComponentProps<typeof DayPeopleModal>['onApprovedMinutes'] = async (
    shiftId, team, approvedMinutes,
  ) => {
    const stored = approvedMinutesForTeam(team, approvedMinutes);
    setPunches((rows) => rows.map((r) => (r.id === shiftId ? { ...r, approved_minutes: stored } : r)));
    setLog((l) => [`Adjusted ${shiftId} (team "${team}") → p_approved_minutes = ${stored === null ? 'NULL' : stored}`, ...l]);
  };

  const onEdit = (shiftId: string) => setLog((l) => [`Edit requested for ${shiftId} (no punch editor in this preview).`, ...l]);

  return (
    <div className="min-h-dvh bg-tt-bg px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold text-tt-text">Approved hours are for Live Hosts only — review</h1>
          <p className="mt-1 max-w-3xl text-sm text-tt-muted">
            The real day modal, confirm queue and person tile, running on fixture punches. A{' '}
            <span className="text-tt-text">Fulfillment</span> tile has no Approved Hours input and no
            &ldquo;Adjust approved hours&rdquo; control: their payable time is the punch — clock in,
            clock out, minus breaks. A <span className="text-tt-text">Live Host</span> tile is
            unchanged, because a host&rsquo;s payable time is verified live time and has to be stated.
            Nothing on this page can reach the database.
          </p>
        </header>

        <div className="mb-4 grid gap-2 sm:grid-cols-2">
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

        {/* WHAT PAYROLL WOULD PAY for each row on screen, from the same two quantities the tile
            shows. A fulfillment row confirmed here reads "(clocked)" — the canonical figure. */}
        <div className="mb-5 rounded-lg border border-tt-border px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">
            Records on {PREVIEW_DATE} — what payroll pays
          </div>
          <ul className="mt-2 space-y-1">
            {cell.people.filter((p) => p.punch).map((p) => (
              <li key={p.punch!.id} className="text-[12.5px] text-tt-text">
                <span className="font-semibold">{p.name}</span>{' '}
                <span className="text-tt-muted capitalize">({p.role})</span>{' '}
                <span className="tabular-nums">{p.punch!.start_time}–{p.punch!.end_time ?? 'open'}</span>
                {' · clocked '}
                <span className="tabular-nums">{formatApprovedMinutes(hoursToMinutes(p.punch!.clockedHours))}</span>
                {' · pays '}
                <span className="font-semibold tabular-nums text-tt-green">
                  {payable(punches.find((r) => r.id === p.punch!.id)!, p.punch!.clockedHours)}
                </span>
                {' · '}
                <span className="text-tt-muted">{p.punch!.confirmed ? 'confirmed' : 'pending'}</span>
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

        {log.length > 0 && (
          <div className="rounded-lg border border-tt-green/25 bg-tt-green/[0.06] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-tt-green">
              What was written (the RPC argument this would have sent)
            </div>
            <ul className="mt-1 space-y-0.5">
              {log.slice(0, 8).map((l, i) => (
                <li key={i} className="text-[12px] tabular-nums text-tt-green">· {l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {showDay && (
        <DayPeopleModal
          day={cell}
          dateLabel="Tuesday, September 15"
          onClose={() => setShowDay(false)}
          onConfirm={onConfirm}
          onApprovedMinutes={onApprovedMinutes}
          onEdit={onEdit}
          onAddShift={() => setLog((l) => ['Add shift is out of scope for this review.', ...l])}
        />
      )}

      {showQueue && (
        <PendingConfirmModal
          byDate={byDate}
          monthLabel="September 2026"
          onClose={() => setShowQueue(false)}
          onConfirm={onConfirm}
          onApprovedMinutes={onApprovedMinutes}
          onEdit={onEdit}
        />
      )}
    </div>
  );
}
