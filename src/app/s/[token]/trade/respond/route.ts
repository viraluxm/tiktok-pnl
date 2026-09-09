import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { respondToTrade } from '@/lib/schedule/trade';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// POST /s/[token]/trade/respond  { tradeId, response: 'accept' | 'decline' }
//
// The coworker's answer. Only the trade's TARGET — as resolved from the token — may answer, and
// the UPDATE re-asserts that with a compare-and-swap. Accepting moves the trade to the manager;
// it still moves no shift.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let body: { tradeId?: unknown; response?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const tradeId = typeof body.tradeId === 'string' ? body.tradeId.trim() : '';
  const response = body.response === 'accept' || body.response === 'decline' ? body.response : null;
  if (!tradeId || !response) return NextResponse.json({ error: 'tradeId and a valid response are required' }, { status: 400 });

  try {
    const result = await respondToTrade(employee, tradeId, response);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ScheduleError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/trade/respond]', (e as Error).message);
    return NextResponse.json({ error: 'Could not record your answer.' }, { status: 500 });
  }
}
