import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getTimecard } from '@/lib/schedule/timecard';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal/timecard — the employee's OWN worked hours: this week, this pay period,
// each punch's canonical clock-in/out and paid duration. Read-only; there is no write route.
// The employee is the token's employee — a client cannot name another one.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  try {
    const timecard = await getTimecard(guard.resolved.employee);
    return NextResponse.json(timecard, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[portal] timecard:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load your hours.' }, { status: 500 });
  }
}
