import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { requestTrade } from '@/lib/schedule/trade';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// POST /s/[token]/trade  { mineInstanceId, theirsInstanceId }  — "Request Trade".
//
// Proposes a one-for-one swap. The REQUESTER is the token's employee — never taken from the body —
// and the target employee is derived server-side from who owns `theirsInstanceId`. Nothing changes
// hands here: the row lands as pending_coworker and only lensed_approve_shift_trade ever moves a shift.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let body: { mineInstanceId?: unknown; theirsInstanceId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const mine = typeof body.mineInstanceId === 'string' ? body.mineInstanceId.trim() : '';
  const theirs = typeof body.theirsInstanceId === 'string' ? body.theirsInstanceId.trim() : '';
  if (!mine || !theirs) return NextResponse.json({ error: 'Missing shift ids' }, { status: 400 });

  try {
    const trade = await requestTrade(employee, mine, theirs);
    return NextResponse.json({ ok: true, trade });
  } catch (e) {
    if (e instanceof ScheduleError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/trade]', (e as Error).message);
    return NextResponse.json({ error: 'Could not send that trade request.' }, { status: 500 });
  }
}
