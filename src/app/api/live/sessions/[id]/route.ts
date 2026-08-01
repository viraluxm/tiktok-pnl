import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Includes store_id/channel_handle/host_id and derives flat store_name/host_name below, so the
// single-session response matches the LiveSession type + the list route. Previously these were
// omitted — a latent tripwire: any consumer reading channel_handle/store_name/host_name off this
// response would silently get undefined (the exact field-mismatch class we audited for).
const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at, store_id, channel_handle, host_id';

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

  // Flat store_name / host_name via manual joins — matches the list route's pattern (this codebase
  // joins by id rather than PostgREST FK embedding). Null when unset/unknown.
  let store_name: string | null = null;
  let host_name: string | null = null;
  if (typeof data.store_id === 'string') {
    const { data: st } = await supabase.from('stores').select('name').eq('id', data.store_id).maybeSingle();
    store_name = (st?.name as string | undefined) ?? null;
  }
  if (typeof data.host_id === 'string') {
    const { data: emp } = await supabase.from('employees').select('name').eq('id', data.host_id).maybeSingle();
    host_name = (emp?.name as string | undefined) ?? null;
  }
  return NextResponse.json({ session: { ...data, store_name, host_name } });
}
