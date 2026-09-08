import { NextResponse } from 'next/server';
import { guardPublicRead } from '@/lib/schedule/publicRoute';
import { getTradeOptions } from '@/lib/schedule/trade';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// GET /s/[token]/portal/trade-options?instanceId= — coworkers (same role, same owner) and the
// shifts of theirs the viewer's own shift could be swapped for. The only client input is WHICH of
// the viewer's shifts; ownership is verified server-side.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicRead(token, req);
  if ('response' in guard) return guard.response;
  const instanceId = (new URL(req.url).searchParams.get('instanceId') ?? '').trim();
  if (!instanceId) return NextResponse.json({ error: 'Missing instanceId' }, { status: 400 });
  try {
    const options = await getTradeOptions(guard.resolved.employee, instanceId);
    return NextResponse.json(options, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof ScheduleError) return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    console.error('[portal] trade-options:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load trade options.' }, { status: 500 });
  }
}
