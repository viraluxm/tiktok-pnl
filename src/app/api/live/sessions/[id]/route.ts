import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT_COLS)
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[live/sessions/:id] fetch error:', error);
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session: data });
}
