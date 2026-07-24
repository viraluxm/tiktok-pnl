import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getAuthUrl } from '@/lib/tiktok/client';

export async function GET(request: Request) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://lensed.io';
  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.redirect(new URL('/login', siteUrl));
  }

  // store_id is now OPTIONAL — the OAuth flow serves two cases:
  //   • RE-AUTH an existing store: store_id present → validate membership, and
  //     the callback stamps the connection onto that store (legacy path).
  //   • CONNECT A NEW SHOP (onboarding first-shop OR add-Nth-shop): store_id
  //     absent → the callback creates/dedups the store from the TikTok shop id
  //     and links a store_membership. Same code path for both new cases.
  const storeId = new URL(request.url).searchParams.get('store_id');
  if (storeId) {
    // Re-auth: the store must belong to the caller.
    const { data: membership } = await supabase
      .from('store_members')
      .select('store_id')
      .eq('user_id', user.id)
      .eq('store_id', storeId)
      .maybeSingle();
    if (!membership) {
      return NextResponse.redirect(new URL('/dashboard?tiktok=error&reason=invalid_store', siteUrl));
    }
  }

  // Generate CSRF state token
  const state = crypto.randomUUID();

  // Store state in cookie for validation on callback
  const cookieStore = await cookies();
  cookieStore.set('tiktok_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  // Also store user ID so we know who to connect on callback
  cookieStore.set('tiktok_oauth_user', user.id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  // Target store cookie — ONLY on the re-auth path. Its absence signals the
  // callback to create/dedup a store from the TikTok shop id instead.
  if (storeId) {
    cookieStore.set('tiktok_oauth_store', storeId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    });
  }

  const authUrl = getAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
