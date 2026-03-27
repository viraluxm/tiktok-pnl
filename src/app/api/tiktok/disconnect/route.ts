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

  // Delete synced order IDs
  await admin
    .from('synced_order_ids')
    .delete()
    .eq('user_id', user.id);

  // Delete TikTok-sourced entries
  await admin
    .from('entries')
    .delete()
    .eq('user_id', user.id)
    .eq('source', 'tiktok');

  // Delete sync logs
  await admin
    .from('sync_logs')
    .delete()
    .eq('user_id', user.id);

  // Delete the connection
  const { error } = await supabase
    .from('tiktok_connections')
    .delete()
    .eq('user_id', user.id);

  if (error) {
    console.error('Error disconnecting TikTok:', error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
