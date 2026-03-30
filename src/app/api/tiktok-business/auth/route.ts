import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getBusinessAuthUrl } from '@/lib/tiktok/business-client';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_SITE_URL || 'https://lensed.io'));
  }

  const state = crypto.randomUUID();

  const cookieStore = await cookies();
  cookieStore.set('tiktok_biz_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  cookieStore.set('tiktok_biz_oauth_user', user.id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.lensed.io';
  const redirectUri = `${siteUrl}/api/tiktok-business/callback`;
  const authUrl = getBusinessAuthUrl(state, redirectUri);

  return NextResponse.redirect(authUrl);
}
