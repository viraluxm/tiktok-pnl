import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: connection, error } = await supabase
    .from('tiktok_connections')
    .select('id, shop_name, shop_cipher, advertiser_ids, connected_at, last_synced_at, sync_cursor, sync_started_at, sync_progress_orders, sync_progress_day')
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching TikTok connection:', error);
    return NextResponse.json({ error: 'Failed to fetch connection' }, { status: 500 });
  }

  if (!connection) {
    return NextResponse.json({ connected: false, connection: null });
  }

  // Check if a sync is currently in progress (started within last 5 minutes)
  let syncInProgress = false;
  if (connection.sync_started_at) {
    const startedAt = new Date(connection.sync_started_at).getTime();
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    syncInProgress = startedAt > fiveMinAgo;
  }

  // isCaughtUp: sync_cursor >= today's date
  const todayStr = new Date().toISOString().split('T')[0];
  const isCaughtUp = !!connection.sync_cursor && connection.sync_cursor >= todayStr;

  return NextResponse.json({
    connected: true,
    connection: {
      id: connection.id,
      shopName: connection.shop_name,
      hasShop: !!connection.shop_cipher,
      advertiserCount: (connection.advertiser_ids as string[] || []).length,
      connectedAt: connection.connected_at,
      lastSyncedAt: connection.last_synced_at,
      needsBackfill: !connection.sync_cursor,
      isCaughtUp,
      syncInProgress,
      syncProgressOrders: connection.sync_progress_orders || 0,
      syncProgressDay: connection.sync_progress_day || null,
    },
  });
}
