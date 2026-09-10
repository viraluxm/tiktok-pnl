import { NextResponse } from 'next/server';
import { requireHostToken } from '@/lib/training/hostRouteGuard';
import {
  PRACTICE_LOG_MAX_BATCH,
  validatePracticeEvent,
  type PracticeLogEvent,
} from '@/lib/training/practiceLog';

export const dynamic = 'force-dynamic';

// POST /api/host/[token]/events — the tokenised twin of /api/admin/training/events.
//
// The session is taken from the TOKEN, never from the body, so a host can only ever
// append to its own timeline. Same all-or-nothing validation: a partial insert would
// leave a hole the replay cannot distinguish from "nothing happened".
//
// Also serves sendBeacon, which sets its own content-type — req.json() parses the
// body text regardless, which is what we want.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as { events?: unknown } | null;
  if (!body || !Array.isArray(body.events)) {
    return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
  }
  if (body.events.length === 0) return NextResponse.json({ inserted: 0 });
  if (body.events.length > PRACTICE_LOG_MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many events (max ${PRACTICE_LOG_MAX_BATCH})` },
      { status: 413 },
    );
  }
  for (const [i, event] of body.events.entries()) {
    const reason = validatePracticeEvent(event);
    if (reason) return NextResponse.json({ error: `events[${i}]: ${reason}` }, { status: 400 });
  }

  const events = body.events as PracticeLogEvent[];
  const { error } = await gate.admin.from('practice_events').insert(
    events.map((e) => ({
      session_id: gate.session.sessionId,
      session_offset_ms: e.session_offset_ms,
      kind: e.kind,
      payload: e.payload,
    })),
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ inserted: events.length }, { headers: { 'Cache-Control': 'no-store' } });
}
