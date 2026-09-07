import Link from 'next/link';
import type { WeekSchedule } from '@/lib/schedule/mySchedule';
import { addDaysISO } from '@/lib/schedule/timezone';
import { weekDatesFor } from '@/lib/schedule/schedulePlan';
import { fmtMonthDay, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';

// MY SCHEDULE on the worker's personal page: one Mon→Sun week of REAL planned shifts, or "Off".
// Server component — no client Supabase, no auth session (see the page). Week navigation is plain
// links carrying `?week=`, so the server decides what to show and the token never leaves the URL
// it already lives in. Read-only by design: releasing, claiming and clocking in stay in the cards
// below, which is where the eligibility checks live.

function dayParts(dateISO: string): { dow: string; md: string } {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    dow: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(dt).toUpperCase(),
    md: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(dt).toUpperCase(),
  };
}

export default function MySchedule({
  token,
  schedule,
  todayISO,
}: {
  token: string;
  schedule: WeekSchedule;
  todayISO: string;
}) {
  const prev = addDaysISO(schedule.start, -7);
  const next = addDaysISO(schedule.start, 7);
  const isThisWeek = schedule.start === weekDatesFor(todayISO)[0];
  const working = schedule.days.filter((d) => d.instance).length;
  const navCls = 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text';

  return (
    <section className="mb-8" aria-label="My schedule">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tt-muted">My schedule</h2>
        {!isThisWeek && (
          <Link href={`/s/${token}`} className="text-xs font-semibold text-tt-cyan hover:underline">This week</Link>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Link href={`/s/${token}?week=${prev}`} aria-label="Previous week" className={navCls}>←</Link>
        <span className="text-sm font-medium text-tt-text">Week of {fmtMonthDay(schedule.start)} – {fmtMonthDay(schedule.end)}</span>
        <Link href={`/s/${token}?week=${next}`} aria-label="Next week" className={navCls}>→</Link>
      </div>

      <ul className="mt-3 divide-y divide-[rgba(255,255,255,0.05)] rounded-lg border border-tt-border bg-tt-card">
        {schedule.days.map(({ date, instance }) => {
          const { dow, md } = dayParts(date);
          const isToday = date === todayISO;
          const past = date < todayISO;
          return (
            <li key={date} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${past ? 'opacity-60' : ''}`}>
              <span className="flex items-baseline gap-2">
                <span className={`w-9 text-[11px] font-bold tracking-wide ${isToday ? 'text-tt-cyan' : 'text-tt-muted'}`}>{dow}</span>
                <span className={`text-[11px] ${isToday ? 'text-tt-cyan' : 'text-tt-muted'}`}>{md}</span>
              </span>
              {instance ? (
                <span className="text-sm font-medium text-tt-text tabular-nums">
                  {fmtTimeRangeLA(instance.starts_at, instance.ends_at)}
                  {isOvernight(instance.starts_at, instance.ends_at) && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
                  {instance.status === 'claimed' && <span className="ml-1.5 text-[11px] text-tt-green">picked up</span>}
                </span>
              ) : (
                <span className="text-sm text-tt-muted">Off</span>
              )}
            </li>
          );
        })}
      </ul>
      {working === 0 && <p className="mt-2 text-xs text-tt-muted">No shifts this week.</p>}
    </section>
  );
}
