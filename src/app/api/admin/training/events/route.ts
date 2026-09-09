import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';
import {
  PRACTICE_LOG_MAX_BATCH,
  validatePracticeEvent,
  type PracticeLogEvent,
} from '@/lib/training/practiceLog';

export const dynamic = 'force-dynamic';

// POST /api/admin/training/events { session_id, events: [...] }
//
// Append the host's buffered timeline (migration 139). Batched: one request per
// comment would mean ~20 hosts each firing constantly.
//
// ALSO SERVES sendBeacon. The host's final flush on pagehide goes out as a beacon,
// which the browser delivers after teardown when a normal fetch would be
// cancelled. A beacon sets its own content-type, so this route must not require
// application/json — req.json() parses the body text regardless, which is exactly
// what we want here.
export async function POST(req: Request) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as {
    session_id?: unknown;
    events?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  if (!isValidTrainingSessionId(body.session_id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  if (!Array.isArray(body.events)) {
    return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
  }
  // Nothing to do is a success, not an error — the host flushes on a timer and can
  // legitimately have an empty buffer.
  if (body.events.length === 0) return NextResponse.json({ inserted: 0 });
  if (body.events.length > PRACTICE_LOG_MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many events (max ${PRACTICE_LOG_MAX_BATCH})` },
      { status: 413 },
    );
  }

  // Validate EVERY event before inserting ANY. A partial insert would leave a
  // timeline with a hole that the replay cannot distinguish from "nothing
  // happened", so the batch is all-or-nothing.
  for (const [i, event] of body.events.entries()) {
    const reason = validatePracticeEvent(event);
    if (reason) {
      return NextResponse.json({ error: `events[${i}]: ${reason}` }, { status: 400 });
    }
  }
  const events = body.events as PracticeLogEvent[];

  const admin = createAdminClient();

  // Confirm the session is THIS owner's before writing anything to it. practice_events
  // has RLS with no policies, so this check is the access control — without it, a
  // valid admin could append to any session id they could guess.
  const { data: session, error: lookupError } = await admin
    .from('practice_sessions')
    .select('id')
    .eq('owner_id', gate.ownerId)
    .eq('id', body.session_id)
    .maybeSingle();

  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
  // A host running a session id that is not registered (a hand-typed or stale
  // link). Reported so the host can surface it, exactly as the heartbeat does.
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { error } = await admin.from('practice_events').insert(
    events.map((e) => ({
      session_id: body.session_id as string,
      session_offset_ms: e.session_offset_ms,
      kind: e.kind,
      payload: e.payload,
    })),
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { inserted: events.length },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
