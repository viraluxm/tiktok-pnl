import { NextResponse } from 'next/server';
import { requireHostToken } from '@/lib/training/hostRouteGuard';

export const dynamic = 'force-dynamic';

// POST /api/host/[token]/end — a clean finish, reported by the host itself.
//
// Idempotent: the `is('ended_at', null)` predicate keeps the FIRST finish, so a
// pagehide beacon arriving after completePractice cannot push the time later.
//
// NOTE this is also what revokes the token, since resolvePracticeHostToken refuses
// an ended session. That is intended: a candidate's link stops working the moment
// their session finishes, with no expiry column to keep in sync.
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;
  const { admin, session } = gate;

  const { data, error } = await admin
    .from('practice_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('owner_id', session.ownerId)
    .eq('id', session.sessionId)
    .is('ended_at', null)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, ended: data !== null });
}
