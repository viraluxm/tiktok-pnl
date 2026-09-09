'use client';

import Link from 'next/link';
import type { TeamScheduleWeek } from '@/lib/schedule/teamSchedule';
import type { AvailableShift } from '@/lib/schedule/offerPlan';
import { PICKUP_REFUSAL_MESSAGES } from '@/lib/schedule/offerPlan';
import { addDaysISO } from '@/lib/schedule/timezone';
import { weekDatesFor } from '@/lib/schedule/schedulePlan';
import { fmtMonthDay, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';
import { PickUpShiftButton } from './phase2Parts';

// TEAM SCHEDULE — who else is working, plus the shifts going spare.
//
// Server component. Every row comes from a REAL shift_instances row (getTeamSchedule does not read
// shift_rules at all), and the fields are an allow-list: name, role, times. No rate, no payroll, no
// worked hours, no phone, no notes, no tokens.
//
// An OFFERED shift still belongs to the person it is assigned to, so it stays under their name in
// the day list and is merely MARKED available. Removing them would tell the team a lie — nobody has
// taken it yet, and until a manager approves someone they are still the person expected to show up.

const ROLE_ORDER = ['fulfillment', 'host'] as const;
const ROLE_LABEL: Record<string, string> = { fulfillment: 'Fulfillment', host: 'Hosts' };

function dayHeading(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
    .format(new Date(Date.UTC(y, m - 1, d))).toUpperCase();
}

export default function TeamSchedule({
  token, week, available, todayISO, onPreviewPickup,
}: {
  token: string;
  week: TeamScheduleWeek;
  available: AvailableShift[];
  todayISO: string;
  /** PREVIEW SEAM — see phase2Parts. Supplied only by /preview/schedule-phase2. */
  onPreviewPickup?: (instanceId: string) => void;
}) {
  const prev = addDaysISO(week.start, -7);
  const next = addDaysISO(week.start, 7);
  const isThisWeek = week.start === weekDatesFor(todayISO)[0];
  const nav = 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text';
  const anyone = week.days.some((d) => d.shifts.length > 0);

  return (
    <>
      <section className="mb-8" aria-label="Available shifts">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tt-muted">
          Available shifts{available.length > 0 ? ` · ${available.length}` : ''}
        </h2>
        <p className="mb-2 text-xs text-tt-muted">Dropped by a teammate — a manager approves the change.</p>
        {available.length === 0 ? (
          <p className="rounded-lg border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted">
            No shifts are up for grabs right now.
          </p>
        ) : (
          <div className="space-y-2">
            {available.map((a) => (
              <div key={a.id} className="rounded-lg border border-tt-border bg-tt-card px-4 py-3">
                {/* flex-wrap: the right slot is either a compact button OR a full sentence
                    ("You already work that day"), and the sentence plus the date/time/role line
                    overflows a 375px screen. Wrapping keeps the desktop layout identical. */}
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-tt-text">
                      {dayHeading(a.shift_date).slice(0, 3)} {fmtMonthDay(a.shift_date)}
                    </p>
                    <p className="text-xs text-tt-muted">
                      {fmtTimeRangeLA(a.starts_at, a.ends_at)}
                      {isOvernight(a.starts_at, a.ends_at) && <span className="ml-1.5">🌙 +1d</span>}
                      {a.role && <span className="ml-1.5">· {ROLE_LABEL[a.role] ?? a.role}</span>}
                    </p>
                    {a.offered_by_name && (
                      <p className="mt-0.5 text-[11px] text-tt-muted">Dropped by {a.offered_by_name}</p>
                    )}
                  </div>
                  <div className="shrink-0">
                    <PickUpShiftButton
                      token={token}
                      instanceId={a.id}
                      offerId={a.offer_id}
                      startsAt={a.starts_at}
                      endsAt={a.ends_at}
                      disabledReason={a.refusal ? PICKUP_REFUSAL_MESSAGES[a.refusal] : null}
                      onPreview={onPreviewPickup ? () => onPreviewPickup(a.id) : undefined}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Team schedule">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tt-muted">Team schedule</h2>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Link href={`/s/${token}?view=team&week=${prev}`} aria-label="Previous week" className={nav}>←</Link>
          <span className="text-sm font-medium text-tt-text">
            Week of {fmtMonthDay(week.start)} – {fmtMonthDay(week.end)}
          </span>
          <Link href={`/s/${token}?view=team&week=${next}`} aria-label="Next week" className={nav}>→</Link>
        </div>
        {!isThisWeek && (
          <div className="mt-2 text-center">
            <Link href={`/s/${token}?view=team`} className="text-xs font-semibold text-tt-cyan hover:underline">This week</Link>
          </div>
        )}

        {!anyone ? (
          <p className="mt-3 rounded-lg border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted">
            Nobody is scheduled this week.
          </p>
        ) : (
          <div className="mt-3 space-y-5">
            {week.days.filter((d) => d.shifts.length > 0).map((d) => {
              const groups = [...ROLE_ORDER.map((r) => ({ key: r as string, list: d.shifts.filter((s) => (s.role ?? '') === r) })),
                { key: 'other', list: d.shifts.filter((s) => !ROLE_ORDER.includes((s.role ?? '') as typeof ROLE_ORDER[number])) }]
                .filter((g) => g.list.length > 0);
              return (
                <div key={d.date}>
                  <h3 className={`text-xs font-bold tracking-wide ${d.date === todayISO ? 'text-tt-cyan' : 'text-tt-text'}`}>
                    {dayHeading(d.date)} <span className="font-normal text-tt-muted">{fmtMonthDay(d.date)}</span>
                  </h3>
                  {groups.map((g) => (
                    <div key={g.key} className="mt-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">
                        {ROLE_LABEL[g.key] ?? 'Other'}
                      </div>
                      <ul className="mt-1 divide-y divide-[rgba(255,255,255,0.05)] rounded-lg border border-tt-border bg-tt-card">
                        {g.list.map((s) => (
                          <li key={s.instance_id} className="flex items-center justify-between gap-3 px-3 py-2">
                            <span className={`truncate text-sm ${s.is_me ? 'font-semibold text-tt-cyan' : 'text-tt-text'}`}>
                              {s.name}{s.is_me ? ' (you)' : ''}
                            </span>
                            <span className="shrink-0 text-right">
                              <span className="text-xs tabular-nums text-tt-muted">
                                {fmtTimeRangeLA(s.starts_at, s.ends_at)}
                                {isOvernight(s.starts_at, s.ends_at) && <span className="ml-1">🌙</span>}
                              </span>
                              {s.offered && (
                                <span className="ml-2 rounded bg-tt-yellow/15 px-1.5 py-0.5 text-[10px] font-bold text-tt-yellow">
                                  Available for pickup
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
