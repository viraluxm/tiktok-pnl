import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';
import { egressClient, isRecordingWriteEnabled, resolveRecordingConfig } from '@/lib/training/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/admin/training/recording/stop { session_id }
//
// Ends the in-flight egress for a session. This is the FAST path, not the only
// path: LiveKit finalises an egress by itself when the room empties, so a host
// whose phone dies still produces a file. The webhook is what actually marks the
// row complete either way — this route only asks egress to stop.
export async function POST(req: Request) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { session_id?: unknown };
  if (!isValidTrainingSessionId(body.session_id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Join through the owner-scoped parent so a caller cannot stop someone else's
  // recording by guessing a session id.
  const { data: session } = await admin
    .from('practice_sessions')
    .select('id')
    .eq('owner_id', gate.ownerId)
    .eq('id', body.session_id)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: row } = await admin
    .from('practice_recordings')
    .select('id, external_id')
    .eq('session_id', body.session_id)
    .eq('status', 'recording')
    .maybeSingle();

  // Nothing in flight is a fine end state for a best-effort call (the session may
  // never have recorded, or the webhook may have completed it already).
  if (!row?.external_id) return NextResponse.json({ ok: true, stopped: false });

  if (!isRecordingWriteEnabled()) {
    console.log('[practice-recording] DRY RUN would stop egress', row.external_id);
    return NextResponse.json({ dry_run: true, would_stop: row.external_id });
  }

  const config = resolveRecordingConfig();
  if (!config.ok) {
    return NextResponse.json({ error: 'Recording not configured', missing: config.missing }, { status: 500 });
  }

  try {
    await egressClient(config.config).stopEgress(row.external_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Non-fatal: LiveKit will finalise on its own when the room empties, and the
    // webhook still lands. Reported, not swallowed.
    console.warn('[practice-recording] stopEgress failed (LiveKit will finalise):', message);
    return NextResponse.json({ ok: true, stopped: false, detail: message });
  }

  return NextResponse.json({ ok: true, stopped: true });
}
