import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveShowDuration } from '@/lib/shows/duration';

export const dynamic = 'force-dynamic';

// GET active-selling duration for a session. Sessions don't reliably get an
// ended_at (a show can read "Live" days later), so the meaningful figure is
// (last capture_event in the window) − started_at. We prefer a SANE ended_at
// when present, else fall back to last-capture. Read-only; additive.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, started_at, ended_at')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Most recent capture in the session window = end of active selling.
  let q = supabase
    .from('capture_events')
    .select('created_at')
    .eq('user_id', user.id)
    .gte('created_at', session.started_at)
    .order('created_at', { ascending: false })
    .limit(1);
  if (session.ended_at) q = q.lte('created_at', session.ended_at);
  const { data: lastCap } = await q;
  const last_capture_at: string | null = lastCap?.[0]?.created_at ?? null;

  // The ended_at-vs-last-capture rule lives in resolveShowDuration() — /api/live/sessions/[id]
  // /net-economics divides by the SAME duration, and two copies would eventually disagree.
  const { duration_ms, source } = resolveShowDuration({
    started_at: session.started_at,
    ended_at: session.ended_at,
    last_capture_at,
  });

  return NextResponse.json({
    started_at: session.started_at,
    ended_at: session.ended_at,
    last_capture_at,
    duration_ms,
    source,
  });
}
