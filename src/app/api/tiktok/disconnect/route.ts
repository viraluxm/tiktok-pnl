import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // 1. Delete all synced order IDs
  const { count: orderCount } = await admin
    .from('synced_order_ids')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  console.log(`[Disconnect] Deleted ${orderCount ?? 0} synced_order_ids`);

  // 2. Delete all entries for this user
  const { count: entryCount } = await admin
    .from('entries')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  console.log(`[Disconnect] Deleted ${entryCount ?? 0} entries`);

  // 3. Delete sync logs
  const { count: logCount } = await admin
    .from('sync_logs')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  console.log(`[Disconnect] Deleted ${logCount ?? 0} sync_logs`);

  // 4. Delete products
  const { count: productCount } = await admin
    .from('products')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  console.log(`[Disconnect] Deleted ${productCount ?? 0} products`);

  // 5. Delete the connection
  const { error: connErr } = await admin
    .from('tiktok_connections')
    .delete()
    .eq('user_id', user.id);

  if (connErr) {
    console.error('[Disconnect] Error deleting tiktok_connections:', connErr);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }

  console.log(`[Disconnect] Fully cleared all data for user ${user.id}`);
  return NextResponse.json({ success: true });
}
