import { NextResponse } from 'next/server';
import { requireHostToken } from '@/lib/training/hostRouteGuard';
import { trainingLiveKitRoom } from '@/lib/training/session';
import {
  buildFileOutput,
  describeRecordingPlan,
  egressClient,
  isRecordingWriteEnabled,
  practiceEncodingOptions,
  recordingObjectPath,
  resolveRecordingConfig,
} from '@/lib/training/recording';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/host/[token]/recording-start { video_track_id, audio_track_id? }
//
// Tokenised twin of /api/admin/training/recording/start. Identical behaviour —
// same flag, same dry run, same failed-row-on-error — with the session fixed by the
// token so a host can only ever start a recording of itself.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const gate = await requireHostToken(params);
  if (!gate.ok) return gate.response;
  const { admin, session } = gate;

  const body = (await req.json().catch(() => ({}))) as {
    video_track_id?: unknown;
    audio_track_id?: unknown;
  };
  if (typeof body.video_track_id !== 'string' || !body.video_track_id) {
    return NextResponse.json({ error: 'video_track_id is required' }, { status: 400 });
  }
  const audioTrackId =
    typeof body.audio_track_id === 'string' && body.audio_track_id ? body.audio_track_id : null;

  const config = resolveRecordingConfig();
  if (!config.ok) {
    return NextResponse.json(
      { error: 'Recording not configured', missing: config.missing },
      { status: 500 },
    );
  }

  // Never start a second egress for a session already recording — it would bill
  // twice and race to write the same object.
  const { data: inFlight } = await admin
    .from('practice_recordings')
    .select('id')
    .eq('session_id', session.sessionId)
    .eq('status', 'recording')
    .maybeSingle();
  if (inFlight) return NextResponse.json({ already_recording: true, recording_id: inFlight.id });

  const room = trainingLiveKitRoom(session.sessionId);
  const startedAtMs = Date.now();
  const objectPath = recordingObjectPath(session.sessionId, startedAtMs);
  const plan = describeRecordingPlan({
    sessionId: session.sessionId,
    room,
    objectPath,
    videoTrackId: body.video_track_id,
    audioTrackId,
    config: config.config,
  });

  if (!isRecordingWriteEnabled()) {
    console.log('[practice-recording] DRY RUN (tokenised host):', plan);
    return NextResponse.json({ dry_run: true, plan });
  }

  let egressId: string;
  try {
    const info = await egressClient(config.config).startTrackCompositeEgress(
      room,
      buildFileOutput(config.config, objectPath),
      {
        videoTrackId: body.video_track_id,
        ...(audioTrackId ? { audioTrackId } : {}),
        encodingOptions: practiceEncodingOptions(),
      },
    );
    egressId = info.egressId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the failed attempt — a recording that never happened must be visible.
    await admin.from('practice_recordings').insert({
      session_id: session.sessionId,
      source: 'egress',
      status: 'failed',
      error: `start failed: ${message}`.slice(0, 2000),
    });
    return NextResponse.json({ error: 'Could not start recording', detail: message }, { status: 502 });
  }

  const { data: row, error: insertErr } = await admin
    .from('practice_recordings')
    .insert({
      session_id: session.sessionId,
      source: 'egress',
      external_id: egressId,
      storage_path: objectPath,
      status: 'recording',
      started_at: new Date(startedAtMs).toISOString(),
    })
    .select('id')
    .single();

  if (insertErr) {
    // Stop it rather than leave an untracked job billing minutes.
    try {
      await egressClient(config.config).stopEgress(egressId);
    } catch {
      /* best effort */
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }
  return NextResponse.json({ recording_id: row.id, egress_id: egressId });
}
