import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { requestPickup } from '@/lib/schedule/offer';
import { ScheduleError } from '@/lib/schedule/release';
import { PICKUP_REFUSAL_MESSAGES } from '@/lib/schedule/offerPlan';

export const dynamic = 'force-dynamic';

// POST /s/[token]/pickup  { instanceId, offerId? }  — "Pick Up Shift".
//
// Files a PENDING request. It never assigns the shift and never makes the requester clock-eligible;
// a manager decides. `offerId` is the cycle the client was looking at — if the shift has since been
// re-offered the request is refused rather than landing on the new cycle (the ABA guard).
//
// The acting employee comes from the token. A client-supplied employee id is neither read nor
// accepted anywhere in this path.
const REFUSALS = new Set<string>([...Object.keys(PICKUP_REFUSAL_MESSAGES), 'NOT_FOUND']);

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let body: { instanceId?: unknown; offerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
  const offerId = typeof body.offerId === 'string' ? body.offerId.trim() : null;
  if (!instanceId) return NextResponse.json({ error: 'Missing instanceId' }, { status: 400 });

  try {
    const result = await requestPickup(employee, instanceId, offerId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ScheduleError && REFUSALS.has(e.code)) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/pickup]', (e as Error).message);
    return NextResponse.json({ error: 'Could not request this shift.' }, { status: 500 });
  }
}
