import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// By-SKU P&L over the selected period. All aggregation happens in the
// pnl_by_sku Postgres function (migration 039); this route just forwards the
// caller's Period + timezone and returns the small per-SKU result set.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const p_from = searchParams.get('from') || null;
  const p_to = searchParams.get('to') || null;
  const p_tz = searchParams.get('tz') || 'America/Los_Angeles';

  const { data, error } = await supabase.rpc('pnl_by_sku', { p_from, p_to, p_tz });
  if (error) {
    console.error('[pnl/by-sku] rpc error:', error);
    return NextResponse.json({ error: 'Failed to load P&L by SKU' }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
