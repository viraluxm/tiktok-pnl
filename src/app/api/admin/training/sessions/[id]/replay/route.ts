import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';
import { RECORDING_BUCKET } from '@/lib/training/recording';

export const dynamic = 'force-dynamic';

// GET /api/admin/training/sessions/[id]/replay
//
// Everything the player needs, in one request: the session, its completed
// recordings with a short-lived signed playback URL each, and the full event
// timeline.
//
// ONE REQUEST ON PURPOSE. The timeline and the video offset are only meaningful
// together — a player that loaded them separately could render an overlay against
// the wrong recording during the gap.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // an hour: long enough to watch a 30-min
                                        // session twice, short enough that a copied
                                        // URL is not a lasting hole in a private bucket

// A 30-minute session logs a few hundred events. This ceiling is far above that but
// stated explicitly, because PostgREST silently truncates at 1000 rows and a silent
// truncation here would render a plausible-looking replay that simply stops.
const MAX_EVENTS = 5000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: session, error: sErr } = await admin
    .from('practice_sessions')
    .select('id, trainee_name, created_at, started_at, ended_at')
    .eq('owner_id', gate.ownerId) // scoping IS the access control here
    .eq('id', id)
    .maybeSingle();
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: recordings, error: rErr } = await admin
    .from('practice_recordings')
    .select('id, status, storage_path, duration_ms, size_bytes, error, started_at')
    .eq('session_id', id)
    .order('started_at', { ascending: true });
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  // Sign only what can actually be played. A failed or in-flight recording is
  // returned WITH its error so the player can say why there is nothing to watch,
  // rather than showing an empty video element.
  const playable = await Promise.all(
    (recordings ?? []).map(async (r) => {
      let url: string | null = null;
      if (r.status === 'complete' && r.storage_path) {
        const { data } = await admin.storage
          .from(RECORDING_BUCKET)
          .createSignedUrl(r.storage_path as string, SIGNED_URL_TTL_SECONDS);
        url = data?.signedUrl ?? null;
      }
      return { ...r, url };
    }),
  );

  const { data: events, error: eErr } = await admin
    .from('practice_events')
    .select('session_offset_ms, kind, payload')
    // Ordered by the same key the index is on, and by id as a tiebreak so events
    // sharing a millisecond replay in the order they were recorded.
    .order('session_offset_ms', { ascending: true })
    .order('id', { ascending: true })
    .eq('session_id', id)
    .limit(MAX_EVENTS);
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 });

  return NextResponse.json(
    {
      session,
      recordings: playable,
      events: events ?? [],
      // Surfaced so the player can warn rather than silently show a short replay.
      events_truncated: (events?.length ?? 0) >= MAX_EVENTS,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
