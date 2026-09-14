import { NextResponse } from 'next/server';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { CapacityError, requestShift, withdrawShiftRequest } from '@/lib/schedule/capacityBoard';

export const dynamic = 'force-dynamic';

// REQUEST SHIFT — the employee side of capacity-derived availability (migration 156).
//
// Public schedule-link surface: NO Supabase auth session is established here (CLAUDE.md). Identity
// comes from the opaque access token, and the service-role client is scoped explicitly by that
// employee_id and their owner in every query downstream. RLS is bypassed by service-role and is
// never the boundary.
//
// NOTHING IN THE BODY IS TRUSTED AS AUTHORIZATION. The body carries only which block and which
// date the employee tapped. The employee id, the owner and the TEAM are all derived server-side
// from the token; the block is then resolved within that owner and the whole opportunity is
// recomputed for this employee before a row is written. A block id belonging to another tenant, or
// to the other team, resolves to nothing.
//
// This files a PENDING request. It assigns nobody, consumes no capacity, and creates no
// shift_instances row — only a manager approval does that.

// resolveEmployeeByToken does NOT filter on employee status (a permanent token outlives a
// departure), so every write surface re-checks it. Same guard as the time-off route.
function activeOr403(status: string): NextResponse | null {
  return status === 'active' ? null : NextResponse.json({ error: 'Not available' }, { status: 403 });
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof CapacityError) {
    const status = e.code === 'BLOCK_UNAVAILABLE' || e.code === 'NOT_PENDING' ? 409
      : e.code === 'BAD_DATE' ? 400
      : e.code === 'REQUEST_FAILED' || e.code === 'READ_FAILED' || e.code === 'WITHDRAW_FAILED' || e.code === 'NO_OWNER' ? 500
      : 409;
    if (status === 500) {
      console.error('[schedule/request-shift]', e.code, e.message);
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
    }
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error('[schedule/request-shift]', (e as Error).message);
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}

// POST { blockId, date } — file a request for one capacity-derived shift.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;
  const gate = activeOr403(employee.status);
  if (gate) return gate;

  let body: { blockId?: unknown; date?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const blockId = typeof body.blockId === 'string' ? body.blockId : '';
  const date = typeof body.date === 'string' ? body.date : '';
  if (!blockId || !date) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  try {
    const { request_id } = await requestShift({ employee, blockId, dateISO: date });
    return NextResponse.json({ ok: true, request_id });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE { requestId } — withdraw my own still-pending request.
export async function DELETE(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;
  const gate = activeOr403(employee.status);
  if (gate) return gate;

  let body: { requestId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  if (!requestId) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  try {
    await withdrawShiftRequest(employee, requestId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
