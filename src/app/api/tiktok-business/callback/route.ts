import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeBusinessCode, getAdvertiserInfo } from '@/lib/tiktok/business-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { encrypt } from '@/lib/crypto';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const authCode = searchParams.get('auth_code');
  const state = searchParams.get('state');

  const cookieStore = await cookies();
  const savedState = cookieStore.get('tiktok_biz_oauth_state')?.value;
  const userId = cookieStore.get('tiktok_biz_oauth_user')?.value;

  cookieStore.delete('tiktok_biz_oauth_state');
  cookieStore.delete('tiktok_biz_oauth_user');

  if (!state || !savedState || state !== savedState) {
    console.error('[TikTok Business] OAuth state mismatch');
    return NextResponse.redirect(`${origin}/dashboard?tiktok_biz=error&reason=state_mismatch`);
  }

  if (!authCode) {
    console.error('[TikTok Business] No auth_code received');
    return NextResponse.redirect(`${origin}/dashboard?tiktok_biz=error&reason=no_code`);
  }

  if (!userId) {
    console.error('[TikTok Business] No user ID in cookie');
    return NextResponse.redirect(`${origin}/login`);
  }

  try {
    const tokenData = await exchangeBusinessCode(authCode);

    // Get advertiser info
    let advertiserId = tokenData.advertiser_ids[0] || '';
    let advertiserName = '';
    if (tokenData.advertiser_ids.length > 0) {
      const infos = await getAdvertiserInfo(tokenData.access_token, tokenData.advertiser_ids);
      if (infos[0]) {
        advertiserId = infos[0].id;
        advertiserName = infos[0].name;
      }
    }

    const admin = createAdminClient();
    const { error: upsertError } = await admin
      .from('tiktok_business_connections')
      .upsert({
        user_id: userId,
        access_token: encrypt(tokenData.access_token),
        advertiser_id: advertiserId,
        advertiser_name: advertiserName,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('[TikTok Business] DB error:', upsertError);
      return NextResponse.redirect(`${origin}/dashboard?tiktok_biz=error&reason=db_error`);
    }

    console.log(`[TikTok Business] Connected: advertiser=${advertiserId} (${advertiserName})`);
    return NextResponse.redirect(`${origin}/dashboard?tiktok_biz=connected`);
  } catch (error) {
    console.error('[TikTok Business] OAuth error:', error);
    return NextResponse.redirect(`${origin}/dashboard?tiktok_biz=error&reason=token_exchange`);
  }
}
