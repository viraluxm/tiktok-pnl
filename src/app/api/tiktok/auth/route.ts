import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getAuthUrl } from '@/lib/tiktok/client';

export async function GET() {
  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_SITE_URL || 'https://lensed.io'));
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

  const authUrl = getAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
