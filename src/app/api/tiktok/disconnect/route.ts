import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Disconnect is per-store now. Require a SPECIFIC active store — never let "all"
  // silently nuke every store's connection/data.
  const activeStore = await getActiveStore();
  if (activeStore === 'all') {
    return NextResponse.json({ error: 'Select a specific store to disconnect' }, { status: 400 });
  }

  const admin = createAdminClient();

  // 1. Delete this store's synced orders only.
  const { count: orderCount } = await admin
    .from('synced_order_ids')
    .delete({ count: 'exact' })
    .eq('user_id', user.id)
    .eq('store_id', activeStore);
  console.log(`[Disconnect] Deleted ${orderCount ?? 0} synced_order_ids for store ${activeStore}`);

  // 2. Regenerate entries from the user's REMAINING orders (rebuild_entries drops all
  //    tiktok-source entries and rebuilds from what's left — so the disconnected
  //    store's contribution is removed while other stores' entries survive).
  const { error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: user.id });
  if (rebuildErr) console.error('[Disconnect] rebuild_entries error:', rebuildErr.message);

  // NOTE: products (org-shared catalog, no store_id) and sync_logs (no store_id) are
  // intentionally NOT deleted — they're not store-scoped and are used by other stores.

  // 3. Delete only this store's connection.
  const { error: connErr } = await admin
    .from('tiktok_connections')
    .delete()
    .eq('user_id', user.id)
    .eq('store_id', activeStore);

  if (connErr) {
    console.error('[Disconnect] Error deleting tiktok_connections:', connErr);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }

  console.log(`[Disconnect] Disconnected store ${activeStore} for user ${user.id}`);
  return NextResponse.json({ success: true, store_id: activeStore });
}
