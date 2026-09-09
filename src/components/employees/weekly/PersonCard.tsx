'use client';

import { useState } from 'react';
import { formatTime12 } from '@/lib/weeklySchedule';
import { confirmErrorMessage, teamOfRole } from '@/lib/timeclock';
import { canRemoveScheduled, formatDelta, type DayPerson } from '@/lib/schedule/calendarModel';
import { canAddWorkedTimeAt } from '@/lib/shifts/manualWorked';
import {
  APPROVED_INPUT_MESSAGES, approvedMinutesRequired, formatApprovedMinutes, parseApprovedInput, splitApprovedMinutes,
} from '@/lib/shifts/approvedHours';
import { hoursToMinutes } from '@/lib/employees';
import PersonAvatar from './PersonAvatar';

// One person's day as a TILE: avatar on top, name under it, the facts under that.
// Shared by the day overlay and the pending-confirmations overlay so a shift looks and behaves
// identically wherever it is reviewed.
//
// Reading order is deliberate: the punch is the largest text because it is the only thing that
// pays. The scheduled span sits below in muted text as context, and the delta between them is
// the whole reason both are on screen.

function badgeFor(p: DayPerson): { text: string; cls: string } {
  switch (p.state) {
    case 'open': return { text: 'On the clock', cls: 'text-tt-cyan border-tt-cyan/40 bg-tt-cyan/10' };
    case 'pending': return { text: 'Needs confirmation', cls: 'text-tt-yellow border-tt-yellow/40 bg-tt-yellow/10' };
    case 'confirmed': return { text: 'Confirmed', cls: 'text-tt-green border-tt-green/40 bg-tt-green/10' };
    case 'no_show': return { text: 'Did not clock in', cls: 'text-tt-red border-tt-red/40 bg-tt-red/10' };
    default: return { text: 'Scheduled', cls: 'text-tt-muted border-tt-border bg-white/5' };
  }
}

function range(start: string, end: string | null): string {
  return end == null ? `${formatTime12(start)} – open` : `${formatTime12(start)} – ${formatTime12(end)}`;
}

export default function PersonCard({
  person,
  dateLabel,
  dateISO,
  onConfirm,
  onApprovedMinutes,
  onEdit,
  onRemoveScheduled,
  onAddWorkedTime,
}: {
  person: DayPerson;
  /** Shown only in the pending overlay, where cards span many days. */
  dateLabel?: string;
  /** 'YYYY-MM-DD' for this cell. Required for the Add Worked Time affordance (see below). */
  dateISO?: string;
  /**
   * Confirm / unconfirm. `approvedMinutes` is the FINAL PAYABLE duration (migration 137) and is
   * sent in the same call as the confirmation, because the two must land together: a confirm that
   * succeeded without its approval would pay a live host their clocked span.
   */
  onConfirm: (shiftId: string, confirmed: boolean, approvedMinutes?: number | null) => Promise<void>;
  /** Change ONLY the payable duration on an already-confirmed shift. Absent → no adjust action. */
  onApprovedMinutes?: (shiftId: string, approvedMinutes: number | null) => Promise<void>;
  onEdit?: (shiftId: string) => void;
  /**
   * ASK to remove this person's one-off scheduled shift. The container owns the confirmation and
   * the request (it has the date label); this tile only surfaces the affordance. Absent → no
   * Remove action, which is how the pending-confirmations overlay keeps its punch-only vocabulary.
   */
  onRemoveScheduled?: (instanceId: string) => void;
  /**
   * ASK to record worked time for a tile that shows "Did not clock in". The container owns the
   * form (it knows the date and holds the modal); this tile only surfaces the affordance — the
   * same split as onRemoveScheduled. Absent → no action, which is how the pending-confirmations
   * overlay keeps its punch-only vocabulary.
   */
  onAddWorkedTime?: (person: DayPerson) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const badge = badgeFor(person);
  const { punch, scheduled } = person;

  // APPROVED HOURS (migration 137) — what payroll pays, kept apart from what the punch says.
  //
  // A LIVE HOST must be given an explicit figure: their payable time is verified live time, and
  // there is no authoritative shift→live-session link to read it from, so defaulting to the
  // clocked span would quietly overpay. Everyone else defaults to the canonical clocked figure,
  // which reproduces today's payroll exactly.
  const isHost = teamOfRole(person.role) === 'host';
  const mustApprove = approvedMinutesRequired(teamOfRole(person.role));
  const defaultMinutes = punch && !punch.isOpen
    ? (punch.approvedMinutes ?? (mustApprove ? null : hoursToMinutes(punch.clockedHours)))
    : null;
  const [approved, setApproved] = useState(() => splitApprovedMinutes(defaultMinutes));
  const [adjusting, setAdjusting] = useState(false);

  // ADD WORKED TIME. Eligibility is TIME-based: offered once the scheduled period has ENDED, so a
  // same-day miss is correctable immediately instead of waiting for midnight, and an overnight span
  // is not eligible until it finishes on the following calendar day. The rule lives in
  // shifts/manualWorked (canAddWorkedTimeAt) so it is pure and unit-tested. `dateISO` absent → the
  // affordance is simply not offered rather than guessed at from the display label.
  const canAddWorked =
    !!onAddWorkedTime && !!dateISO && canAddWorkedTimeAt(person, dateISO);

  // REMOVE SHIFT is offered on a PLAN-ONLY tile and nowhere else. The rule lives in calendarModel
  // (canRemoveScheduled); a tile with any punch is excluded there, which keeps this action away
  // from worked/payroll rows.
  //
  // `&& !canAddWorked` is PRECEDENCE, and it became load-bearing when eligibility went time-based.
  // canRemoveScheduled is still DAY-granular ('scheduled' covers anything today or later), so a
  // shift TODAY whose period has already ended now satisfies BOTH rules, and the tile would offer
  // Remove Shift and Add Worked Time at the same time. Once a shift is over the honest question is
  // "what did they work?", not "cancel the plan" — so Add Worked Time wins.
  //
  // Not a safety hole in either direction: planShiftRemoval() on the server independently refuses
  // to remove an already-started shift. This just stops the tile offering something the server
  // would reject, and leaves canRemoveScheduled's own rule and tests untouched.
  const canRemove = !!onRemoveScheduled && canRemoveScheduled(person) && !canAddWorked;

  async function run(confirmed: boolean) {
    if (!punch) return;
    // Unconfirming withdraws the approval too (the RPC clears it), so no figure is read here.
    if (!confirmed) {
      setBusy(true); setErr(null);
      try { await onConfirm(punch.id, false); } catch (e) { setErr(confirmErrorMessage((e as Error).message)); } finally { setBusy(false); }
      return;
    }
    const parsed = parseApprovedInput(approved.hours, approved.minutes, mustApprove);
    if (!parsed.ok) { setErr(APPROVED_INPUT_MESSAGES[parsed.code]); return; }
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(punch.id, true, parsed.minutes);
    } catch (e) {
      setErr(confirmErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  /** Payroll-only correction on an already-confirmed shift. The punch is never touched. */
  async function saveApproved() {
    if (!punch || !onApprovedMinutes) return;
    const parsed = parseApprovedInput(approved.hours, approved.minutes, mustApprove);
    if (!parsed.ok) { setErr(APPROVED_INPUT_MESSAGES[parsed.code]); return; }
    setBusy(true);
    setErr(null);
    try {
      await onApprovedMinutes(punch.id, parsed.minutes);
      setAdjusting(false);
    } catch (e) {
      setErr(confirmErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const approvedInputs = (
    <div className="mt-2 w-full text-left">
      <div className="text-[9px] font-bold uppercase tracking-wider text-tt-muted">Approved hours</div>
      <div className="mt-1 flex items-center gap-1">
        <input
          type="number" min={0} max={24} inputMode="numeric" aria-label="Approved hours"
          value={approved.hours} onChange={(e) => setApproved((a) => ({ ...a, hours: e.target.value }))}
          className="min-w-0 flex-1 rounded-lg border border-tt-input-border bg-tt-input-bg px-1.5 py-1 text-center text-[13px] tabular-nums text-tt-text"
        />
        <span className="text-[10px] text-tt-muted">hrs</span>
        <input
          type="number" min={0} max={59} inputMode="numeric" aria-label="Approved minutes"
          value={approved.minutes} onChange={(e) => setApproved((a) => ({ ...a, minutes: e.target.value }))}
          className="min-w-0 flex-1 rounded-lg border border-tt-input-border bg-tt-input-bg px-1.5 py-1 text-center text-[13px] tabular-nums text-tt-text"
        />
        <span className="text-[10px] text-tt-muted">min</span>
      </div>
      {isHost && (
        <p className="mt-1 text-[9px] leading-snug text-tt-muted">Live Host hours are verified live time, not the clocked span.</p>
      )}
    </div>
  );

  return (
    <div className="flex flex-col items-center rounded-xl border border-tt-border bg-white/[0.02] p-3 text-center">
      <PersonAvatar name={person.name} state={person.state} size="lg" />

      <div className="mt-2 w-full truncate text-sm font-semibold text-tt-text" title={person.name}>{person.name}</div>
      {person.role && <div className="text-[10px] capitalize text-tt-muted">{person.role}</div>}
      {dateLabel && <div className="text-[10px] text-tt-muted/70">{dateLabel}</div>}

      <span className={`mt-1.5 rounded-full border px-2 py-0.5 text-[9.5px] font-semibold ${badge.cls}`}>{badge.text}</span>

      {/* CLOCKED — the attendance record. Labelled, because since migration 137 it is NOT
          necessarily what pays, and a manager confirming a host shift must see both figures. */}
      <div className="mt-2 w-full">
        {punch ? (
          <>
            <div className="text-[9px] font-bold uppercase tracking-wider text-tt-muted">Clocked</div>
            <div className="text-[12.5px] font-medium tabular-nums text-tt-text">{range(punch.start_time, punch.end_time)}</div>
            <div className="text-[10.5px] tabular-nums text-tt-muted">
              {punch.isOpen ? 'in progress' : formatApprovedMinutes(hoursToMinutes(punch.clockedHours))}
              {punch.breakMinutes > 0 && ` · ${punch.breakMinutes}m break`}
            </div>
          </>
        ) : (
          <div className="text-[12.5px] font-medium text-tt-muted">No punch</div>
        )}
      </div>

      {/* APPROVED — what payroll pays. Only meaningful once a figure exists. */}
      {punch && !punch.isOpen && punch.approvedMinutes != null && !adjusting && (
        <div className="mt-1.5 w-full">
          <div className="text-[9px] font-bold uppercase tracking-wider text-tt-muted">Approved</div>
          <div className="text-[12.5px] font-semibold tabular-nums text-tt-green">{formatApprovedMinutes(punch.approvedMinutes)}</div>
        </div>
      )}

      {/* THE PLAN — context, never the headline. */}
      <div className="mt-1 w-full text-[10px] leading-snug text-tt-muted">
        {scheduled ? (
          <>
            Sched {range(scheduled.start_time, scheduled.end_time)} · {scheduled.hours}h
            {person.deltaHours != null && (
              <span className={person.deltaHours > 0 ? ' font-semibold text-tt-yellow' : person.deltaHours < 0 ? ' font-semibold text-tt-cyan' : ''}>
                {' · '}{formatDelta(person.deltaHours)}
              </span>
            )}
          </>
        ) : person.wasScheduled ? (
          <span className="text-tt-muted/70">Scheduled</span>
        ) : (
          <span className="text-tt-muted/70">Not scheduled</span>
        )}
      </div>

      {punch?.autoClosed && (
        <div className="mt-1 text-[9.5px] leading-snug text-tt-yellow">
          Auto-closed — hours are a default, not measured
        </div>
      )}
      {err && <div className="mt-1 text-[9.5px] text-tt-red">{err}</div>}

      {/* PLAN-ONLY action. Mutually exclusive with the punch actions below by construction —
          canRemoveScheduled() returns false the moment a punch exists. */}
      {canRemove && scheduled && (
        <div className="mt-2 flex w-full">
          <button
            type="button" onClick={() => onRemoveScheduled(scheduled.id)}
            className="flex-1 rounded-lg border border-tt-border px-2 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:border-tt-red/40 hover:bg-tt-red/10 hover:text-tt-red"
          >Remove Shift</button>
        </div>
      )}

      {/* THE MISSED-PUNCH CORRECTION. Only on a past scheduled day with no punch at all, so it can
          never appear beside worked time that already exists. Wording is deliberate: this records
          what the manager says was worked, it does not invent a clock-in. */}
      {canAddWorked && (
        <div className="mt-2 flex w-full">
          <button
            type="button" onClick={() => onAddWorkedTime(person)}
            className="flex-1 rounded-lg border border-tt-yellow/40 bg-tt-yellow/10 px-2 py-1.5 text-[11px] font-semibold text-tt-yellow transition-colors hover:bg-tt-yellow/20"
          >Add Worked Time</button>
        </div>
      )}

      {/* The manager's payable figure. Shown while confirming (so it lands in the same call) and
          while correcting an already-confirmed shift. */}
      {punch && !punch.isOpen && punch.confirmable && (!punch.confirmed || adjusting) && approvedInputs}

      {/* Actions. Edit is offered on ANY real punch — a 19h forgotten clock-out has to be
          correctable, and refusing to confirm it is not a fix. */}
      {punch && (
        <div className="mt-2 flex w-full gap-1.5">
          {onEdit && (
            <button
              type="button" onClick={() => onEdit(punch.id)}
              className="flex-1 rounded-lg border border-tt-border px-2 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
            >Edit</button>
          )}
          {!punch.isOpen && punch.confirmable && (
            punch.confirmed ? (
              <button
                type="button" disabled={busy} onClick={() => run(false)}
                className="flex-1 rounded-lg border border-tt-border px-2 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text disabled:opacity-50"
              >{busy ? '…' : 'Unconfirm'}</button>
            ) : (
              <button
                type="button" disabled={busy} onClick={() => run(true)}
                className="flex-1 rounded-lg bg-tt-green/20 px-2 py-1.5 text-[11px] font-semibold text-tt-green transition-colors hover:bg-tt-green/30 disabled:opacity-50"
              >{busy ? '…' : 'Confirm'}</button>
            )
          )}
        </div>
      )}

      {/* PAYROLL-ONLY CORRECTION. Offered on a confirmed punch so a wrong payable duration is
          fixed HERE rather than by rewriting the clock-in and clock-out. */}
      {punch && !punch.isOpen && punch.confirmed && onApprovedMinutes && (
        adjusting ? (
          <div className="w-full">
            <div className="flex w-full gap-1.5 pt-2">
              <button
                type="button" disabled={busy} onClick={() => { setAdjusting(false); setErr(null); setApproved(splitApprovedMinutes(punch.approvedMinutes ?? defaultMinutes)); }}
                className="flex-1 rounded-lg border border-tt-border px-2 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text disabled:opacity-50"
              >Cancel</button>
              <button
                type="button" disabled={busy} onClick={saveApproved}
                className="flex-1 rounded-lg bg-tt-cyan/20 px-2 py-1.5 text-[11px] font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/30 disabled:opacity-50"
              >{busy ? '…' : 'Save'}</button>
            </div>
          </div>
        ) : (
          <button
            type="button" onClick={() => { setAdjusting(true); setErr(null); }}
            className="mt-1.5 text-[10px] font-semibold text-tt-muted underline transition-colors hover:text-tt-text"
          >Adjust approved hours</button>
        )
      )}
    </div>
  );
}
