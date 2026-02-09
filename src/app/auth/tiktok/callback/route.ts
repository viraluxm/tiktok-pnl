import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCodeForToken, getAuthorizedShops } from '@/lib/tiktok/client';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // TikTok Shop OAuth returns 'code'
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const cookieStore = await cookies();
  const savedState = cookieStore.get('tiktok_oauth_state')?.value;
  const userId = cookieStore.get('tiktok_oauth_user')?.value;

  // Clear OAuth cookies
  cookieStore.delete('tiktok_oauth_state');
  cookieStore.delete('tiktok_oauth_user');

  // Validate state for CSRF protection
  if (!state || !savedState || state !== savedState) {
    console.error('TikTok OAuth state mismatch');
    return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=state_mismatch`);
  }

  if (!code) {
    console.error('No code received from TikTok Shop');
    return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=no_code`);
  }

  if (!userId) {
    console.error('No user ID found in cookie');
    return NextResponse.redirect(`${origin}/login`);
  }

  try {
    // Exchange code for access token via TikTok Shop API
    const tokenData = await exchangeCodeForToken(code);

    // Get authorized shops
    let shopCipher: string | null = null;
    let shopName: string | null = null;
    try {
      const shops = await getAuthorizedShops(tokenData.access_token);
      if (shops.length > 0) {
        shopCipher = shops[0].shop_cipher;
        shopName = shops[0].shop_name;
      }
    } catch (shopError) {
      console.warn('Could not fetch shops:', shopError);
    }

    // Store connection in database using admin client (bypasses RLS)
    const adminClient = createAdminClient();

    const tokenExpiresAt = new Date(Date.now() + tokenData.access_token_expire_in * 1000).toISOString();

    const { error: upsertError } = await adminClient
      .from('tiktok_connections')
      .upsert({
        user_id: userId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_expires_at: tokenExpiresAt,
        shop_cipher: shopCipher,
        shop_name: shopName || tokenData.seller_name || 'TikTok Shop',
        connected_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error('Failed to save TikTok connection:', upsertError);
      return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=db_error`);
    }

    return NextResponse.redirect(`${origin}/dashboard?tiktok=connected`);
  } catch (error) {
    console.error('TikTok OAuth error:', error);
    return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=token_exchange`);
  }
}
