import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { isValidTrainingSessionId } from '@/lib/training/session';
import { RECORDING_BUCKET } from '@/lib/training/recording';
import ReplayPlayer, { type ReplayData } from '@/components/training/ReplayPlayer';

export const dynamic = 'force-dynamic';

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const MAX_EVENTS = 5000;

// Replay one practice session: the real footage with the overlay re-rendered from
// its timeline.
//
// Loaded server-side rather than through the API route so the page arrives complete
// — the timeline and the video offset are only meaningful together, and a client
// that fetched them separately could briefly render an overlay against the wrong
// take. Admin-gated by (app)/admin/layout.tsx; every query is owner-scoped anyway.
export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidTrainingSessionId(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const admin = createAdminClient();
  const { data: session } = await admin
    .from('practice_sessions')
    .select('id, trainee_name, created_at, started_at, ended_at')
    .eq('owner_id', user.id)
    .eq('id', id)
    .maybeSingle();
  if (!session) notFound();

  const { data: recordings } = await admin
    .from('practice_recordings')
    .select('id, status, storage_path, duration_ms, size_bytes, error, started_at')
    .eq('session_id', id)
    .order('started_at', { ascending: true });

  // Sign only what can be played; a failed take is passed through WITH its error so
  // the player can explain itself instead of showing an empty video element.
  const signed = await Promise.all(
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

  const { data: events } = await admin
    .from('practice_events')
    .select('session_offset_ms, kind, payload')
    .eq('session_id', id)
    .order('session_offset_ms', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_EVENTS);

  const data: ReplayData = {
    session: session as ReplayData['session'],
    recordings: signed as ReplayData['recordings'],
    events: (events ?? []) as ReplayData['events'],
    events_truncated: (events?.length ?? 0) >= MAX_EVENTS,
  };

  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-8 text-tt-text">
      <div className="mx-auto w-full max-w-4xl">
        <Link
          href="/admin/training/practice-mode"
          className="inline-block text-[13px] text-tt-cyan hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
        >
          ← Back to Practice Mode
        </Link>
        <h1 className="mt-3 text-2xl font-bold">{session.trainee_name || 'Unnamed session'}</h1>
        <p className="mt-1 text-[13px] text-tt-muted">
          {new Date(session.started_at ?? session.created_at).toLocaleString()} ·{' '}
          {data.events.length} moments
        </p>

        <div className="mt-6">
          <ReplayPlayer data={data} />
        </div>
      </div>
    </div>
  );
}
