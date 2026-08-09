import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import type { ShiftInstance } from '@/types';
import { resolveEmployeeByToken } from '@/lib/schedule/tokens';
import { guardPublicReadAllowed } from '@/lib/schedule/publicRoute';
import {
  getMyShifts,
  getBoard,
  getCurrentPeriodDrops,
  hasActiveRules,
  isReleasable,
  type BoardRow,
} from '@/lib/schedule/board';
import { DROP_CAP } from '@/lib/schedule/drops';
import { fmtDateLA, fmtTimeRangeLA, fmtCalendarDate } from '@/lib/schedule/format';
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

  const [myShifts, board, { period, drops }] = await Promise.all([
    getMyShifts(employee),
    getBoard(employee),
    getCurrentPeriodDrops(employee),
  ]);

  const periodEndLabel = fmtCalendarDate(period.end);
  const atCap = drops.drops >= DROP_CAP;

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

      <Section title="Your shifts" subtitle="Next 14 days">
        {myShifts.length === 0 ? (
          <Empty>No shifts scheduled in the next two weeks.</Empty>
        ) : (
          myShifts.map((s) => (
            <Row key={s.id}>
              <ShiftFacts inst={s} role={employee.role} />
              <div className="shrink-0">
                {s.status === 'released' ? (
                  <span className="text-xs text-tt-yellow">Released · waiting for pickup</span>
                ) : s.status === 'claimed' ? (
                  <span className="text-xs text-tt-green">Picked up</span>
                ) : isReleasable(s) ? (
                  <ReleaseButton token={token} instanceId={s.id} periodEnd={periodEndLabel} atCap={atCap} />
                ) : (
                  <span className="text-xs text-tt-muted">Within 24h — contact a manager</span>
                )}
              </div>
            </Row>
          ))
        )}
      </Section>

      <Section title="Open shifts" subtitle="Released by teammates — claim one you can work">
        {board.length === 0 ? (
          <Empty>Nothing on the board right now.</Empty>
        ) : (
          board.map((b) => (
            <Row key={b.id}>
              <ShiftFacts inst={b} role={b.releaser_role} releasedBy={b.releaser_name} />
              <div className="shrink-0">
                <ClaimButton token={token} instanceId={b.id} />
              </div>
            </Row>
          ))
        )}
      </Section>
    </Shell>
  );
}

function ShiftFacts({
  inst,
  role,
  releasedBy,
}: {
  inst: Pick<ShiftInstance, 'starts_at' | 'ends_at'> | BoardRow;
  role: string | null;
  releasedBy?: string | null;
}) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-tt-text">{fmtDateLA(inst.starts_at)}</p>
      <p className="text-xs text-tt-muted">
        {fmtTimeRangeLA(inst.starts_at, inst.ends_at)}
        {role ? ` · ${role}` : ''}
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
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-tt-border bg-tt-card px-4 py-3">
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted">{children}</p>;
}
