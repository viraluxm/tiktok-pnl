import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getPayPeriodHistory } from '@/lib/schedule/timecard';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal/pay-periods — the employee's OWN recent closed pay periods: the window,
// the scheduled Pay Day, approved hours and hours still waiting for approval. No dollar figure of
// any kind, and no record that a payment happened — Lensed does not store one.
//
// Read-only, and the employee is the token's employee; nothing in the request names a person.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  try {
    const periods = await getPayPeriodHistory(guard.resolved.employee);
    return NextResponse.json({ periods }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[portal] pay-periods:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load your pay periods.' }, { status: 500 });
  }
}
