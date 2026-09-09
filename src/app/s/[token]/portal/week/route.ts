import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getPortalWeek } from '@/lib/schedule/portalSnapshot';
import { resolveWeekStart } from '@/lib/schedule/mySchedule';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal/week?start=YYYY-MM-DD — one Mon→Sun week (my shifts + team coverage).
// `start` may be any date inside the week; anything malformed falls back to the current week.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  const start = new URL(req.url).searchParams.get('start') ?? undefined;
  try {
    const week = await getPortalWeek(guard.resolved.employee, resolveWeekStart(start));
    return NextResponse.json(week, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[portal] week:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load that week.' }, { status: 500 });
  }
}
