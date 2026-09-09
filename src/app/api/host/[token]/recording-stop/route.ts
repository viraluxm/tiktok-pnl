import { NextResponse } from 'next/server';
import { requireHostToken } from '@/lib/training/hostRouteGuard';
import { egressClient, isRecordingWriteEnabled, resolveRecordingConfig } from '@/lib/training/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/host/[token]/recording-stop
//
// The fast path only: LiveKit finalises an egress itself when the room empties, and
// the webhook (or reconcile) is what actually completes the row. A failure here
// costs nothing.
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;

  const { data: row } = await gate.admin
    .from('practice_recordings')
    .select('external_id')
    .eq('session_id', gate.session.sessionId)
    .eq('status', 'recording')
    .maybeSingle();
  if (!row?.external_id) return NextResponse.json({ ok: true, stopped: false });

  if (!isRecordingWriteEnabled()) {
    return NextResponse.json({ dry_run: true, would_stop: row.external_id });
  }
  const config = resolveRecordingConfig();
  if (!config.ok) {
    return NextResponse.json({ error: 'Recording not configured', missing: config.missing }, { status: 500 });
  }
  try {
    await egressClient(config.config).stopEgress(row.external_id);
  } catch (err) {
    console.warn('[practice-recording] stopEgress failed (LiveKit will finalise):', err);
    return NextResponse.json({ ok: true, stopped: false });
  }
  return NextResponse.json({ ok: true, stopped: true });
}
