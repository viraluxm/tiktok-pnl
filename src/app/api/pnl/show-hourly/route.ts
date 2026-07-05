import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Per-hour breakdown for a single show, bucketed in the seller's local time.
// Uses the SAME period filter as pnl_by_show so the hourly rows sum exactly to
// that show's totals. Aggregation runs in pnl_show_hourly (migration 039).
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const p_session_id = searchParams.get('session_id');
  if (!p_session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const p_from = searchParams.get('from') || null;
  const p_to = searchParams.get('to') || null;
  const p_tz = searchParams.get('tz') || 'America/Los_Angeles';

  const { data, error } = await supabase.rpc('pnl_show_hourly', { p_session_id, p_from, p_to, p_tz });
  if (error) {
    console.error('[pnl/show-hourly] rpc error:', error);
    return NextResponse.json({ error: 'Failed to load hourly breakdown' }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
