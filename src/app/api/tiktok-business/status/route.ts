import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: connection } = await supabase
    .from('tiktok_business_connections')
    .select('id, advertiser_id, advertiser_name, connected_at')
    .eq('user_id', user.id)
    .single();

  if (!connection) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    advertiserId: connection.advertiser_id,
    advertiserName: connection.advertiser_name,
    connectedAt: connection.connected_at,
  });
}
