import { NextResponse } from 'next/server';
import { requireHostToken } from '@/lib/training/hostRouteGuard';

export const dynamic = 'force-dynamic';

// POST /api/host/[token]/heartbeat — the tokenised twin of
// /api/admin/training/sessions/[id]/heartbeat. Same two narrow writes (touch
// last_seen_at, stamp started_at once), but the session comes from the token rather
// than the request, so a host can only ever beat for its own session.
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;
  const { admin, session } = gate;
  const nowIso = new Date().toISOString();

  const { data, error } = await admin
    .from('practice_sessions')
    .update({ last_seen_at: nowIso })
    .eq('owner_id', session.ownerId) // explicit scoping; RLS is not the boundary here
    .eq('id', session.sessionId)
    .select('started_at')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // One-shot: only ever matches while started_at IS NULL, so a later beat cannot
  // move the session's start time.
  if (data.started_at === null) {
    await admin
      .from('practice_sessions')
      .update({ started_at: nowIso })
      .eq('owner_id', session.ownerId)
      .eq('id', session.sessionId)
      .is('started_at', null);
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
