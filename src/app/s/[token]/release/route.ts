import { NextResponse } from 'next/server';
import { guardPublicWrite, scheduleErrorResponse } from '@/lib/schedule/publicRoute';
import { releaseShift } from '@/lib/schedule/release';
import { broadcastShiftReleased } from '@/lib/schedule/sms';

export const dynamic = 'force-dynamic';

// POST /s/[token]/release  { instanceId }  — public, no auth session (see CLAUDE.md).
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
    const released = await releaseShift(employee, instanceId);
    // Ends_at for the broadcast message. One broadcast per release (this path runs once per
    // successful release), log-only until SMS_SEND_ENABLED. Never fail the release on SMS trouble.
    try {
      await broadcastShiftReleased({
        instanceId,
        role: employee.role, // the released shift's role = the releaser's role (086)
        storeId: released.store_id,
        shiftDate: released.shift_date,
        startsAt: released.starts_at,
        endsAt: released.ends_at,
        releaserId: employee.id,
        ownerUserId: employee.user_id,
      });
    } catch (e) {
      console.error('[schedule] release broadcast failed (release still succeeded):', (e as Error).message);
    }
    return NextResponse.json({ ok: true, ...released });
  } catch (e) {
    return scheduleErrorResponse(e);
  }
}
