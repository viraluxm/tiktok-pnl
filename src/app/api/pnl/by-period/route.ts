import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Daily P&L time series over the selected period (local days).
// Aggregation runs in the pnl_by_period Postgres function (migration 039).
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const p_from = searchParams.get('from') || null;
  const p_to = searchParams.get('to') || null;
  const p_tz = searchParams.get('tz') || 'America/Los_Angeles';

  const { data, error } = await supabase.rpc('pnl_by_period', { p_from, p_to, p_tz });
  if (error) {
    console.error('[pnl/by-period] rpc error:', error);
    return NextResponse.json({ error: 'Failed to load P&L by period' }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
