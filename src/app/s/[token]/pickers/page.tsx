import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { guardPublicReadAllowed } from '@/lib/schedule/publicRoute';
import { resolveCrewToken, loadCrewBoard, currentDay } from '@/lib/crewBoard/server';
import {
  formatHourLabel, formatClocked, addDaysISO,
  type CrewBoard, type CrewPickerRow, type HourBucket,
} from '@/lib/shipping/crewBoard';
import { AutoRefresh } from './parts';

export const dynamic = 'force-dynamic';

// PUBLIC manager crew board. No Supabase auth session is EVER established here (service-role only,
// scoped by the owner resolved from the token; middleware excludes /s/*). See CLAUDE.md.
//
// Read-only by design: there is no write path on this route at all.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function CrewBoardPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { token } = await params;
  const { date } = await searchParams;

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!guardPublicReadAllowed(token, ip)) {
    return <Shell><P>Too many requests — please wait a moment and refresh.</P></Shell>;
  }

  const tok = await resolveCrewToken(token);
  if (!tok) notFound();

  const today = currentDay();
  const day = date && DAY_RE.test(date) && date <= today ? date : today;
  const board = await loadCrewBoard(tok, day);
  const isToday = day === today;
  const maxHour = maxHourOf(board);

  return (
    <Shell>
      {isToday && <AutoRefresh seconds={90} />}

      <header className="mb-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-xl font-semibold text-tt-text">{tok.label}</h1>
          <span className="text-xs text-tt-muted">{dayLabel(day, today)}</span>
        </div>
        <p className="text-xs text-tt-muted mt-1">
          {tok.crew === 'am' ? '4:00 AM – 3:00 PM' : '3:00 PM – 4:00 AM'} Pacific
          {isToday && <span className="text-tt-green"> · live</span>}
        </p>
      </header>

      <nav className="flex items-center gap-2 mb-5 text-sm">
        <A href={`/s/${token}/pickers?date=${addDaysISO(day, -1)}`}>‹ Prev</A>
        {!isToday && <A href={`/s/${token}/pickers`}>Today</A>}
        {!isToday && <A href={`/s/${token}/pickers?date=${addDaysISO(day, 1)}`}>Next ›</A>}
      </nav>

      <Summary board={board} />

      {board.picking.length === 0 && board.noPicks.length === 0 ? (
        <Empty>No one has clocked in or picked yet on this shift.</Empty>
      ) : (
        <>
          {board.picking.length > 0 && (
            <Section title={`Picking (${board.picking.length})`}>
              {board.picking.map((r) => (
                <PickerCard key={r.employee_id ?? r.name} row={r} target={board.targetBoxes} maxHour={maxHour} />
              ))}
            </Section>
          )}

          {board.noPicks.length > 0 && (
            <Section
              title={`No picks this shift (${board.noPicks.length})`}
              // The board records completed BOXES. It has no event for boxing, restocking or
              // set-aside work — scan_log carries no employee column and pick_slots/pick_racks
              // carry no employee stamp — so a zero here is NOT evidence of idleness, and is
              // deliberately shown without a target or a shortfall.
              subtitle="Hours only — the board can't see boxing, restocking or set-aside work."
            >
              <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3 flex flex-wrap gap-x-5 gap-y-1.5">
                {board.noPicks.map((r) => (
                  <span key={r.employee_id ?? r.name} className="text-sm text-tt-text">
                    {r.name}
                    <span className="text-tt-muted"> · {formatClocked(r.clocked_ms)}</span>
                    {r.on_clock && <span className="text-tt-green text-xs"> ●</span>}
                  </span>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <footer className="mt-6 pt-4 border-t border-tt-border text-[11px] text-tt-muted leading-relaxed">
        Bar height = boxes finished in that hour. One box = one label.
        {isToday && ' The current hour is still in progress and will look short.'}
      </footer>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Summary({ board }: { board: CrewBoard }) {
  const avail = board.availablePerPicker;
  const hasTarget = board.targetBoxes != null;
  return (
    <div className="mb-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5">
        <Stat label="Boxes" value={board.totalBoxes.toLocaleString()} />
        <Stat label="Picking" value={String(board.pickingCount)} />
        {hasTarget
          ? <Stat label="Hit target" value={`${board.hitTarget} / ${board.pickingCount}`} />
          : <Stat label="On shift" value={String(board.pickingCount + board.noPicks.length)} />}
        {hasTarget
          ? <Stat label="Target" value={String(board.targetBoxes)} />
          : <Stat label="No picks" value={String(board.noPicks.length)} />}
      </div>

      {/* Available-per-picker context. Without it a flat per-person minimum measures staffing
          against order volume rather than effort: on 16 of the 17 morning shifts before
          2026-09-08 there were not enough boxes in the building for everyone on shift to reach
          200. A manager needs to see WHY someone is short before acting on it. */}
      {avail != null && (
        <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-2.5">
          <p className="text-xs text-tt-muted">
            {board.totalBoxes.toLocaleString()} boxes ÷ {board.pickingCount} picking ={' '}
            <span className="text-tt-text font-semibold tabular-nums">{Math.round(avail)}</span> available each
          </p>
          {board.targetReachable === false && (
            <p className="text-xs text-tt-yellow mt-1">
              ⚠ Not enough volume this shift for everyone to reach {board.targetBoxes}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PickerCard({ row, target, maxHour }: { row: CrewPickerRow; target: number | null; maxHour: number }) {
  const diff = target != null ? row.boxes - target : null;
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="min-w-0 truncate font-semibold text-sm text-tt-text" title={row.name}>
          {row.name}
          <span className="text-tt-muted font-normal text-xs"> · {formatClocked(row.clocked_ms)}</span>
          {row.on_clock && <span className="text-tt-green text-xs"> ●</span>}
        </div>
        <div className="shrink-0 text-sm tabular-nums whitespace-nowrap">
          <span className="font-extrabold text-tt-text">{row.boxes}</span>
          {target != null && <span className="text-tt-muted"> / {target}</span>}
          {diff != null && (
            <span className={`ml-2 font-bold ${diff >= 0 ? 'text-tt-green' : 'text-tt-muted'}`}>
              {diff >= 0 ? `+${diff}` : diff}
            </span>
          )}
        </div>
      </div>
      <HourBars hours={row.hours} maxHour={maxHour} />
    </div>
  );
}

function HourBars({ hours, maxHour }: { hours: HourBucket[]; maxHour: number }) {
  const H = 40;
  return (
    <div className="flex gap-[3px] items-end overflow-x-auto">
      {hours.map((h) => {
        const px = h.boxes === 0 ? 2 : Math.max(4, Math.round((h.boxes / maxHour) * H));
        // The in-progress hour is ALWAYS partial — at 1:47 PM the 1p bar is 40 minutes short of
        // complete. Marked so a short bar can't be misread as someone collapsing.
        return (
          <div key={h.hourStartMs} className="flex-1 min-w-[16px] flex flex-col items-center gap-1">
            <div className={`text-[10px] tabular-nums ${h.boxes === 0 ? 'text-tt-muted/50' : 'text-tt-text/80'}`}>
              {h.boxes}
            </div>
            <div style={{ height: H }} className="w-full flex items-end">
              <div
                style={{ height: px, opacity: h.boxes === 0 ? 1 : 0.45 + 0.55 * (h.boxes / maxHour) }}
                className={`w-full rounded-t-[3px] ${
                  h.boxes === 0 ? 'bg-white/10' : h.inProgress ? 'bg-tt-cyan/50' : 'bg-tt-cyan'
                }`}
              />
            </div>
            <div className={`text-[9px] ${h.inProgress ? 'text-tt-cyan' : 'text-tt-muted/70'}`}>
              {formatHourLabel(h.labelHour)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Tallest bar across the whole board, so every picker's bars share one scale and rows stay
// visually comparable. Floor of 1 keeps the division safe on an empty board.
function maxHourOf(board: CrewBoard): number {
  let max = 1;
  for (const r of board.picking) for (const h of r.hours) if (h.boxes > max) max = h.boxes;
  return max;
}

function dayLabel(dayISO: string, todayISO: string): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return dayISO === todayISO ? `${base} · Today` : base;
}

// ─────────────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-tt-bg px-4 py-6">
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="text-xs uppercase tracking-wide text-tt-muted mb-1">{title}</h2>
      {subtitle && <p className="text-[11px] text-tt-muted/80 mb-2">{subtitle}</p>}
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-3.5 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-tt-muted">{label}</div>
      <div className="text-2xl font-extrabold text-tt-text mt-0.5 tabular-nums leading-none">{value}</div>
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-tt-muted text-sm">{children}</p>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-tt-border bg-tt-card px-4 py-6 text-center text-sm text-tt-muted">
      {children}
    </div>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="min-h-[40px] px-3 py-2 rounded-lg border border-tt-border text-tt-text hover:bg-tt-card-hover transition-colors inline-flex items-center"
    >
      {children}
    </a>
  );
}
