import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { cancelTrade } from '@/lib/schedule/trade';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// POST /s/[token]/trade/cancel  { tradeId } — the requester withdraws a trade that nobody has
// approved yet. Only the token's employee, and only if they proposed it.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let body: { tradeId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const tradeId = typeof body.tradeId === 'string' ? body.tradeId.trim() : '';
  if (!tradeId) return NextResponse.json({ error: 'Missing tradeId' }, { status: 400 });

  try {
    const result = await cancelTrade(employee, tradeId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ScheduleError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/trade/cancel]', (e as Error).message);
    return NextResponse.json({ error: 'Could not cancel that trade.' }, { status: 500 });
  }
}
