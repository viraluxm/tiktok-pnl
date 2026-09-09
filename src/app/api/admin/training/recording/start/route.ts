import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId, trainingLiveKitRoom } from '@/lib/training/session';
import {
  buildFileOutput,
  describeRecordingPlan,
  egressClient,
  isRecordingWriteEnabled,
  practiceEncodingOptions,
  recordingObjectPath,
  resolveRecordingConfig,
} from '@/lib/training/recording';

export const runtime = 'nodejs'; // the egress client signs JWTs; not edge-safe
export const dynamic = 'force-dynamic';

// POST /api/admin/training/recording/start { session_id, video_track_id, audio_track_id? }
//
// Starts a track-composite egress for one practice session and records the attempt
// in practice_recordings (migration 143).
//
// SHIPS LOG-ONLY. With PRACTICE_RECORDING_WRITE_ENABLED unset this route resolves
// everything, reports the exact egress request it WOULD issue, and writes nothing —
// no egress started, no row inserted, no metered minute spent. That dry run is how
// the whole path gets inspected before the first real recording.
export async function POST(req: Request) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as {
    session_id?: unknown;
    video_track_id?: unknown;
    audio_track_id?: unknown;
  };

  if (!isValidTrainingSessionId(body.session_id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  // A track-composite egress is defined BY its track ids. Without a video track
  // there is nothing to record, so this is a hard requirement rather than a
  // best-effort skip.
  if (typeof body.video_track_id !== 'string' || !body.video_track_id) {
    return NextResponse.json({ error: 'video_track_id is required' }, { status: 400 });
  }
  const audioTrackId =
    typeof body.audio_track_id === 'string' && body.audio_track_id ? body.audio_track_id : null;

  const sessionId = body.session_id;
  const videoTrackId = body.video_track_id;

  const config = resolveRecordingConfig();
  if (!config.ok) {
    // Say exactly which variables are missing. A recording that silently never
    // happens is the failure this whole feature exists to avoid.
    return NextResponse.json(
      { error: 'Recording not configured', missing: config.missing },
      { status: 500 },
    );
  }

  const admin = createAdminClient();

  // The session must be this owner's. practice_recordings has RLS with no
  // policies, so this check is the access control.
  const { data: session, error: sessionErr } = await admin
    .from('practice_sessions')
    .select('id')
    .eq('owner_id', gate.ownerId)
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionErr) return NextResponse.json({ error: sessionErr.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Never start a second egress for a session that already has one running — a
  // duplicate would bill twice and race to write the same object. The host calls
  // this once per run, but a retry or a double-mount must be harmless.
  const { data: inFlight } = await admin
    .from('practice_recordings')
    .select('id, external_id')
    .eq('session_id', sessionId)
    .eq('status', 'recording')
    .maybeSingle();
  if (inFlight) {
    return NextResponse.json({ already_recording: true, recording_id: inFlight.id });
  }

  const room = trainingLiveKitRoom(sessionId);
  const startedAtMs = Date.now();
  const objectPath = recordingObjectPath(sessionId, startedAtMs);
  const plan = describeRecordingPlan({
    sessionId,
    room,
    objectPath,
    videoTrackId,
    audioTrackId,
    config: config.config,
  });

  if (!isRecordingWriteEnabled()) {
    // Dry run. Logged server-side too, so it shows up in Vercel logs for a real
    // host session rather than only in a hand-made request.
    console.log('[practice-recording] DRY RUN (PRACTICE_RECORDING_WRITE_ENABLED unset):', plan);
    return NextResponse.json({ dry_run: true, plan });
  }

  let egressId: string;
  try {
    const info = await egressClient(config.config).startTrackCompositeEgress(
      room,
      buildFileOutput(config.config, objectPath),
      {
        videoTrackId,
        // Omitted entirely when there is no mic track — passing an empty string
        // makes egress fail rather than record video-only.
        ...(audioTrackId ? { audioTrackId } : {}),
        encodingOptions: practiceEncodingOptions(),
      },
    );
    egressId = info.egressId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the FAILED attempt. A start that throws is exactly the case that used
    // to vanish — a reviewer must be able to see that a recording was attempted
    // and why it did not happen.
    await admin.from('practice_recordings').insert({
      session_id: sessionId,
      source: 'egress',
      status: 'failed',
      error: `start failed: ${message}`.slice(0, 2000),
    });
    return NextResponse.json({ error: 'Could not start recording', detail: message }, { status: 502 });
  }

  const { data: row, error: insertErr } = await admin
    .from('practice_recordings')
    .insert({
      session_id: sessionId,
      source: 'egress',
      external_id: egressId,
      storage_path: objectPath,
      status: 'recording',
      started_at: new Date(startedAtMs).toISOString(),
    })
    .select('id')
    .single();

  if (insertErr) {
    // The egress IS running but we failed to record it. Stop it rather than leave
    // an untracked job billing minutes with nothing pointing at it.
    try {
      await egressClient(config.config).stopEgress(egressId);
    } catch {
      /* best effort — the error below is what matters */
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ recording_id: row.id, egress_id: egressId, path: objectPath });
}
