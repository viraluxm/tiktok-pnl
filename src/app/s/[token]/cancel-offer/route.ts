import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { cancelOffer, CANCEL_OFFER_MESSAGES } from '@/lib/schedule/offer';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// POST /s/[token]/cancel-offer  { instanceId, offerId }  — "Cancel Offer".
//
// Public tokenized route: no auth session (middleware excludes /s/*). The ACTING EMPLOYEE is
// resolved from the token by guardPublicWrite — never from the body — so a request cannot cancel
// on someone else's behalf no matter what it sends. The RPC re-asserts ownership server-side too,
// so a worker holding their OWN valid token still cannot cancel a coworker's offer.
//
// `offerId` IS accepted from the client, and that is safe by design: it is not an identity, it is
// a GENERATION marker. Sending someone else's or an old one cannot widen access — it can only fail
// the CAS and be refused as STALE_OFFER. Requiring it is what stops a stale tab from cancelling an
// offer cycle the worker never saw.
const REFUSALS = new Set<string>(Object.keys(CANCEL_OFFER_MESSAGES));

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let instanceId: string;
  let offerId: string;
  try {
    const body = await req.json();
    instanceId = String(body.instanceId ?? '');
    offerId = String(body.offerId ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!instanceId) return NextResponse.json({ error: 'Missing instanceId' }, { status: 400 });
  if (!offerId) return NextResponse.json({ error: 'Missing offerId' }, { status: 400 });

  try {
    const result = await cancelOffer(employee, instanceId, offerId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ScheduleError && REFUSALS.has(e.code)) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'SHIFT_NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/cancel-offer]', (e as Error).message);
    return NextResponse.json({ error: 'Could not cancel this offer.' }, { status: 500 });
  }
}
