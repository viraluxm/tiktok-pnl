import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import type { ShiftInstance } from '@/types';
import { resolveEmployeeByToken } from '@/lib/schedule/tokens';
import { guardPublicReadAllowed } from '@/lib/schedule/publicRoute';
import {
  getMyShifts,
  getBoard,
  getMyPendingClaims,
  getCurrentPeriodDrops,
  hasActiveRules,
  isReleasable,
} from '@/lib/schedule/board';
import { DROP_CAP } from '@/lib/schedule/drops';
import { fmtDateLA, fmtTimeRangeLA, fmtCalendarDate, isOvernight } from '@/lib/schedule/format';
import { ReleaseButton, ClaimButton } from './parts';

export const dynamic = 'force-dynamic';

// PUBLIC employee schedule page. No Supabase auth session is EVER established here (service-role
// only, scoped by the token's employee_id; middleware excludes /s/*). See CLAUDE.md.
export default async function SchedulePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!guardPublicReadAllowed(token, ip)) {
    return <Shell><p className="text-tt-muted">Too many requests — please wait a moment and refresh.</p></Shell>;
  }

  const resolved = await resolveEmployeeByToken(token);
  if (!resolved) notFound();
  const { employee } = resolved;

  // A valid token with no schedule set: show an empty state, NOT a redirect or 404.
  if (!(await hasActiveRules(employee))) {
    return (
      <Shell>
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-tt-text">{employee.name}</h1>
        </header>
        <Empty>No schedule set yet — talk to your manager.</Empty>
      </Shell>
    );
  }

  const [myShifts, board, pendingClaims, { period, drops }] = await Promise.all([
    getMyShifts(employee),
    getBoard(employee),
    getMyPendingClaims(employee),
    getCurrentPeriodDrops(employee),
  ]);

  const periodEndLabel = fmtCalendarDate(period.end);
  const atCap = drops.drops >= DROP_CAP;

  const pending = pendingClaims.length > 0 && (
    <Section
      key="pending"
      title={`Pending approval · ${pendingClaims.length}`}
      subtitle="Over 40 hours — a manager is reviewing. Not yours yet."
    >
      {pendingClaims.map((p) => (
        <Card key={p.claim_id}>
          <div className="flex items-center justify-between gap-3">
            <ShiftFacts inst={p} />
            <span className="shrink-0 text-xs text-tt-yellow">⏳ Awaiting approval</span>
          </div>
        </Card>
      ))}
    </Section>
  );

  const yourShifts = (
    <Section key="yours" title="Your shifts" subtitle="Next 14 days">
      {myShifts.length === 0 ? (
        <Empty>No shifts scheduled in the next two weeks.</Empty>
      ) : (
        myShifts.map((s) => {
          const releasableNow = s.status === 'scheduled' && isReleasable(s);
          const within24 = s.status === 'scheduled' && !releasableNow;
          return (
            <Card key={s.id}>
              <div className="flex items-center justify-between gap-3">
                <ShiftFacts inst={s} />
                <div className="shrink-0">
                  {s.status === 'released' ? (
                    <span className="text-xs text-tt-yellow">Released · waiting for pickup</span>
                  ) : s.status === 'claimed' ? (
                    <span className="text-xs text-tt-green">Picked up</span>
                  ) : releasableNow ? (
                    <ReleaseButton token={token} instanceId={s.id} periodEnd={periodEndLabel} atCap={atCap} />
                  ) : null}
                </div>
              </div>
              {within24 && (
                // Its own line below the time so it never splits the time row (fix #3).
                <p className="mt-1.5 text-xs text-tt-muted">Within 24h — contact a manager</p>
              )}
            </Card>
          );
        })
      )}
    </Section>
  );

  const openShifts = (
    <Section
      key="open"
      title={board.length > 0 ? `Open shifts · ${board.length} available` : 'Open shifts'}
      subtitle="Released by teammates — claim one you can work"
    >
      {board.length === 0 ? (
        <Empty>Nothing on the board right now.</Empty>
      ) : (
        board.map((b) => (
          <Card key={b.id}>
            <div className="flex items-center justify-between gap-3">
              <ShiftFacts inst={b} releasedBy={b.releaser_name} />
              <div className="shrink-0">
                <ClaimButton token={token} instanceId={b.id} />
              </div>
            </div>
          </Card>
        ))
      )}
    </Section>
  );

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-tt-text">{employee.name}</h1>
        <p className="mt-1 text-sm text-tt-muted">Pay period ends {periodEndLabel}</p>
        <p className={`mt-1 text-sm font-medium ${atCap ? 'text-tt-red' : 'text-tt-muted'}`}>
          {drops.drops} of {DROP_CAP} drops used
          {drops.excused > 0 ? ` · ${drops.excused} excused` : ''}
        </p>
      </header>

      {/* An in-flight OT claim leads (the viewer just filed it and wants to see it landed), then:
          a non-empty board (time-sensitive, usually arrived-from-SMS) leads; an empty board sinks
          below the actual schedule (fix #1). */}
      {pending}
      {board.length > 0 ? [openShifts, yourShifts] : [yourShifts, openShifts]}
    </Shell>
  );
}

// Date + time; overnight shifts get the same 🌙 +1d marker the team-tab calendar uses (fix #2).
// Role is intentionally NOT shown — every row is the viewer's own role class (fix #4).
function ShiftFacts({
  inst,
  releasedBy,
}: {
  inst: Pick<ShiftInstance, 'starts_at' | 'ends_at'>;
  releasedBy?: string | null;
}) {
  const overnight = isOvernight(inst.starts_at, inst.ends_at);
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-tt-text">{fmtDateLA(inst.starts_at)}</p>
      <p className="text-xs text-tt-muted">
        {fmtTimeRangeLA(inst.starts_at, inst.ends_at)}
        {overnight && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
      </p>
      {releasedBy && <p className="mt-0.5 text-[11px] text-tt-muted">Released by {releasedBy}</p>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-md bg-tt-bg px-4 py-8 text-tt-text">{children}</main>
  );
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-tt-muted">{title}</h2>
      {subtitle && <p className="mb-2 text-xs text-tt-muted">{subtitle}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-tt-border bg-tt-card px-4 py-3">{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted">{children}</p>;
}
