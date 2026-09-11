import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getTimecard, getTimecardPeriod } from '@/lib/schedule/timecard';
import { laTodayISO } from '@/lib/schedule/timezone';
import { resolvePeriodStart } from '@/lib/schedule/timecardModel';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal/timecard — the employee's OWN worked hours: this week, this pay period,
// each punch's canonical clock-in/out and paid duration. Read-only; there is no write route.
// The employee is the token's employee — a client cannot name another one.
//
// ?period=YYYY-MM-DD returns ONE past pay period in the same day-by-day shape (the detail behind a
// row in Previous Pay Periods). The parameter selects a WINDOW and nothing else: resolvePeriodStart
// refuses anything that is not a real boundary of the canonical biweekly cycle, and whose rows are
// read is still decided solely by the token. An unusable value is a 400, never a silent other-period.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  const requested = new URL(req.url).searchParams.get('period');
  try {
    if (requested !== null) {
      const period = resolvePeriodStart(requested, laTodayISO());
      if (!period) return NextResponse.json({ error: 'That pay period does not exist.' }, { status: 400 });
      const payload = await getTimecardPeriod(guard.resolved.employee, period);
      return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
    }
    const timecard = await getTimecard(guard.resolved.employee);
    return NextResponse.json(timecard, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[portal] timecard:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load your hours.' }, { status: 500 });
  }
}
