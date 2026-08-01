import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Real columns match the LiveSession type (store_id/channel_handle/host_id). The derived
// store_name/host_name are NOT added here: the /end response is never displayed (useEndSession
// discards it), so a name-join on the end path would be dead work. The single-session GET, which
// IS read, derives both.
const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at, store_id, channel_handle, host_id';

// End a live session: sets status='ended' + ended_at. Idempotent-ish (409 if already ended).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: existing, error: fetchErr } = await supabase
    .from('live_sessions')
    .select('id, ended_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchErr) {
    console.error('[live/sessions/:id/end] fetch error:', fetchErr);
    return NextResponse.json({ error: 'Failed to end session' }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (existing.ended_at) return NextResponse.json({ error: 'Session already ended' }, { status: 409 });

  const { data, error } = await supabase
    .from('live_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('[live/sessions/:id/end] update error:', error);
    return NextResponse.json({ error: 'Failed to end session' }, { status: 500 });
  }
  return NextResponse.json({ session: data });
}
