import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

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

  // Prefer ended_at only when it's sane: after the start and not wildly past the
  // last sale (guards a stale "ended days later" value). Otherwise last-capture.
  let source: 'ended_at' | 'last_capture' = 'last_capture';
  let end: string | null = last_capture_at;
  if (session.ended_at && session.started_at) {
    const s = new Date(session.started_at).getTime();
    const e = new Date(session.ended_at).getTime();
    const lc = last_capture_at ? new Date(last_capture_at).getTime() : null;
    const sane = e > s && (lc == null || e <= lc + 6 * 3600 * 1000);
    if (sane) { source = 'ended_at'; end = session.ended_at; }
  }

  const duration_ms = end && session.started_at
    ? new Date(end).getTime() - new Date(session.started_at).getTime()
    : null;

  return NextResponse.json({
    started_at: session.started_at,
    ended_at: session.ended_at,
    last_capture_at,
    duration_ms,
    source,
  });
}
