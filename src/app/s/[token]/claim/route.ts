import { NextResponse } from 'next/server';
import { guardPublicWrite, scheduleErrorResponse } from '@/lib/schedule/publicRoute';
import { claimShift } from '@/lib/schedule/claim';

export const dynamic = 'force-dynamic';

// POST /s/[token]/claim  { instanceId }  — public, no auth session.
// Returns { result: 'claimed' } (auto-approved, < 40h) or { result: 'pending_approval' } (OT).
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
    const result = await claimShift(employee, instanceId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return scheduleErrorResponse(e);
  }
}
