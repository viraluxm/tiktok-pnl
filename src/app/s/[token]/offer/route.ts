import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { offerShift } from '@/lib/schedule/offer';
import { ScheduleError } from '@/lib/schedule/release';
import { DROP_REFUSAL_MESSAGES } from '@/lib/schedule/offerPlan';

export const dynamic = 'force-dynamic';

// POST /s/[token]/offer  { instanceId }  — "Drop Shift".
//
// Public tokenized route: no auth session (middleware excludes /s/*). The ACTING EMPLOYEE is
// resolved from the token by guardPublicWrite — never from the body — so a request cannot act as
// someone else no matter what it sends. The only client input is which shift.
//
// This OFFERS the shift while leaving it assigned. It is not the legacy release endpoint and does
// not touch status/employee_id/released_at.
const REFUSALS = new Set<string>([...Object.keys(DROP_REFUSAL_MESSAGES), 'NOT_FOUND']);

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let instanceId: string;
  try {
    instanceId = String((await req.json()).instanceId ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!instanceId) return NextResponse.json({ error: 'Missing instanceId' }, { status: 400 });

  try {
    const result = await offerShift(employee, instanceId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ScheduleError && REFUSALS.has(e.code)) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
    }
    console.error('[schedule/offer]', (e as Error).message);
    return NextResponse.json({ error: 'Could not offer this shift.' }, { status: 500 });
  }
}
