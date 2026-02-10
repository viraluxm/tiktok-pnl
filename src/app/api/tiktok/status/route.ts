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
    .select('id, shop_name, shop_cipher, advertiser_ids, connected_at, last_synced_at')
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows, which is expected when not connected
    console.error('Error fetching TikTok connection:', error);
    return NextResponse.json({ error: 'Failed to fetch connection' }, { status: 500 });
  }

  if (!connection) {
    return NextResponse.json({
      connected: false,
      connection: null,
    });
  }

  return NextResponse.json({
    connected: true,
    connection: {
      id: connection.id,
      shopName: connection.shop_name,
      hasShop: !!connection.shop_cipher,
      advertiserCount: (connection.advertiser_ids as string[] || []).length,
      connectedAt: connection.connected_at,
      lastSyncedAt: connection.last_synced_at,
    },
  });
}
