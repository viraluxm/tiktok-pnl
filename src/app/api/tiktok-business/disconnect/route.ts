import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();

  await admin.from('ad_spend').delete().eq('user_id', user.id);
  await admin.from('tiktok_business_connections').delete().eq('user_id', user.id);

  console.log(`[TikTok Business] Disconnected for user ${user.id}`);
  return NextResponse.json({ success: true });
}
