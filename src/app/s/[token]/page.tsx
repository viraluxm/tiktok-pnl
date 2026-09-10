import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { resolveEmployeeByToken } from '@/lib/schedule/tokens';
import { guardPublicReadAllowed } from '@/lib/schedule/publicRoute';
import { getPortalSnapshot, getPortalWeek } from '@/lib/schedule/portalSnapshot';
import { mondayOf } from '@/lib/schedule/portalModel';
import { parseNav } from '@/components/portal/navState';
import PortalRoot from '@/components/portal/PortalRoot';

export const dynamic = 'force-dynamic';

// PUBLIC employee portal. No Supabase auth session is EVER established here (service-role only,
// scoped by the token's employee; middleware excludes /s/*). See CLAUDE.md.
//
// The server resolves the token, builds the first snapshot and the requested week, and renders the
// client app with them so the first paint is complete. From then on the client fetches
// /s/[token]/portal/* itself; tab, segment, week and day live in the query string (see nav.ts).
export default async function EmployeePortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!guardPublicReadAllowed(token, ip)) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center text-sm text-tt-muted">
        Too many requests — please wait a moment and refresh.
      </main>
    );
  }

  const resolved = await resolveEmployeeByToken(token);
  if (!resolved) notFound();
  const { employee } = resolved;

  const flat = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === 'string') flat.set(k, one);
  }
  const initialNav = parseNav(flat);

  const now = new Date();
  const snapshot = await getPortalSnapshot(employee, now);
  const weekStart = initialNav.week ?? mondayOf(snapshot.todayISO);
  const week = await getPortalWeek(employee, weekStart);

  return <PortalRoot token={token} initialSnapshot={snapshot} initialWeek={week} initialNav={initialNav} />;
}
