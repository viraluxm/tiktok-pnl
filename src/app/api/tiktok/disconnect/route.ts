import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Use admin client for all deletes to bypass RLS
  const admin = createAdminClient();

  // 1. Delete synced order IDs
  const { error: orderIdsErr } = await admin
    .from('synced_order_ids')
    .delete()
    .eq('user_id', user.id);
  if (orderIdsErr) console.error('Error deleting synced_order_ids:', orderIdsErr);

  // 2. Delete TikTok-sourced entries
  const { error: entriesErr } = await admin
    .from('entries')
    .delete()
    .eq('user_id', user.id)
    .eq('source', 'tiktok');
  if (entriesErr) console.error('Error deleting tiktok entries:', entriesErr);

  // 3. Delete sync logs
  const { error: logsErr } = await admin
    .from('sync_logs')
    .delete()
    .eq('user_id', user.id);
  if (logsErr) console.error('Error deleting sync_logs:', logsErr);

  // 4. Delete the connection (this also removes sync_cursor/sync_page_cursor)
  const { error: connErr } = await admin
    .from('tiktok_connections')
    .delete()
    .eq('user_id', user.id);
  if (connErr) {
    console.error('Error deleting tiktok_connections:', connErr);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }

  console.log(`[Disconnect] Cleared all TikTok data for user ${user.id}`);
  return NextResponse.json({ success: true });
}
