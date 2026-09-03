'use client';

import { useState } from 'react';
import { formatTime12 } from '@/lib/weeklySchedule';
import { confirmErrorMessage } from '@/lib/timeclock';
import { formatDelta, type DayPerson } from '@/lib/schedule/calendarModel';
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
  onConfirm,
  onEdit,
}: {
  person: DayPerson;
  /** Shown only in the pending overlay, where cards span many days. */
  dateLabel?: string;
  onConfirm: (shiftId: string, confirmed: boolean) => Promise<void>;
  onEdit?: (shiftId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const badge = badgeFor(person);
  const { punch, scheduled } = person;

  async function run(confirmed: boolean) {
    if (!punch) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(punch.id, confirmed);
    } catch (e) {
      setErr(confirmErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center rounded-xl border border-tt-border bg-white/[0.02] p-3 text-center">
      <PersonAvatar name={person.name} state={person.state} size="lg" />

      <div className="mt-2 w-full truncate text-sm font-semibold text-tt-text" title={person.name}>{person.name}</div>
      {person.role && <div className="text-[10px] capitalize text-tt-muted">{person.role}</div>}
      {dateLabel && <div className="text-[10px] text-tt-muted/70">{dateLabel}</div>}

      <span className={`mt-1.5 rounded-full border px-2 py-0.5 text-[9.5px] font-semibold ${badge.cls}`}>{badge.text}</span>

      {/* THE PUNCH — the only figure that pays, so it is the biggest thing on the tile. */}
      <div className="mt-2 w-full">
        {punch ? (
          <>
            <div className="text-[12.5px] font-medium tabular-nums text-tt-text">{range(punch.start_time, punch.end_time)}</div>
            <div className="text-[10.5px] tabular-nums text-tt-muted">
              {punch.isOpen ? 'in progress' : `${punch.hours}h`}
              {punch.breakMinutes > 0 && ` · ${punch.breakMinutes}m break`}
            </div>
          </>
        ) : (
          <div className="text-[12.5px] font-medium text-tt-muted">No punch</div>
        )}
      </div>

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
    </div>
  );
}
