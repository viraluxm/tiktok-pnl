import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Per-store connections. Return the full set the switcher needs (`stores`), and —
  // for back-compat with the current consumer — a single `connection` scoped to the
  // active store (or the first, in "all" mode).
  const activeStore = await getActiveStore();
  let q = supabase
    .from('tiktok_connections')
    .select('id, store_id, shop_name, shop_cipher, shop_logo, advertiser_ids, connected_at, last_synced_at, sync_cursor, sync_started_at, sync_progress_orders, sync_progress_day')
    .eq('user_id', user.id);
  if (activeStore !== 'all') q = q.eq('store_id', activeStore);
  const { data: rows, error } = await q;

  if (error) {
    console.error('Error fetching TikTok connection:', error);
    return NextResponse.json({ error: 'Failed to fetch connection' }, { status: 500 });
  }

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;

  const stores = (rows ?? []).map((c) => {
    const syncInProgress = !!c.sync_started_at && new Date(c.sync_started_at).getTime() > fiveMinAgo;
    return {
      id: c.id,
      storeId: c.store_id,
      shopName: c.shop_name,
      hasShop: !!c.shop_cipher,
      advertiserCount: ((c.advertiser_ids as string[]) || []).length,
      connectedAt: c.connected_at,
      lastSyncedAt: c.last_synced_at,
      needsBackfill: !c.sync_cursor,
      isCaughtUp: !!c.sync_cursor && c.sync_cursor >= todayStr,
      syncInProgress,
      syncProgressOrders: c.sync_progress_orders || 0,
      syncProgressDay: c.sync_progress_day || null,
      shopLogo: c.shop_logo || null,
    };
  });

  return NextResponse.json({
    connected: stores.length > 0,
    connection: stores[0] ?? null, // back-compat single-connection consumer
    stores,                        // per-store list for the switcher (Phase E)
  });
}
