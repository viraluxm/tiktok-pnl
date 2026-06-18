import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT_COLS)
    .eq('user_id', user.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[live/sessions] list error:', error);
    return NextResponse.json({ error: 'Failed to load sessions' }, { status: 500 });
  }
  return NextResponse.json({ sessions: data ?? [] });
}

// Start a live session.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let title = 'Live session';
  try {
    const body = await req.json();
    if (body && typeof body.title === 'string' && body.title.trim()) {
      title = body.title.trim().slice(0, 120);
    }
  } catch {
    // No body is fine; use the default title.
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('live_sessions')
    .insert({ user_id: user.id, title, status: 'live', started_at: nowIso, source: 'manual' })
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('[live/sessions] create error:', error);
    return NextResponse.json({ error: 'Failed to start session' }, { status: 500 });
  }
  return NextResponse.json({ session: data }, { status: 201 });
}
