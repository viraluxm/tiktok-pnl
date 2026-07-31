import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { getAuthUrl } from '@/lib/tiktok/client';

// Two modes, never ambiguous:
//   ?store_id=…  RECONNECT an existing owned store (membership-checked). Unchanged.
//   ?new=1       CONNECT-FIRST: create a brand-new store FROM the OAuth result. The callback
//                names it from the shop; no name is typed. Requires a resolvable org so the
//                callback can populate stores.org_id (NOT NULL).
export async function GET(request: Request) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://lensed.io';
  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.redirect(new URL('/login', siteUrl));
  }

  const url = new URL(request.url);
  const storeId = url.searchParams.get('store_id');
  const isNew = url.searchParams.get('new') === '1';

  // Never ambiguous: exactly one creation/reconnect intent per request.
  if (isNew && storeId) {
    return NextResponse.redirect(new URL('/dashboard?tiktok=error&reason=ambiguous_mode', siteUrl));
  }

  const cookieStore = await cookies();
  const state = crypto.randomUUID();

  // ── NEW-STORE (connect-first) mode ──────────────────────────────────────────────────
  if (isNew) {
    // The callback will INSERT stores(org_id, name=shop_name); org_id is NOT NULL, so bail
    // now (before spending an auth code) if the user has no resolvable org.
    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) {
      return NextResponse.redirect(new URL('/dashboard?tiktok=error&reason=no_org', siteUrl));
    }

    cookieStore.set('tiktok_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
    cookieStore.set('tiktok_oauth_user', user.id, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
    // Signals the callback to run the connect-first branch. Do NOT set tiktok_oauth_store.
    cookieStore.set('tiktok_oauth_new', '1', { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });

    return NextResponse.redirect(getAuthUrl(state));
  }

  // ── EXISTING-STORE (reconnect) mode — unchanged behavior ────────────────────────────
  // Which store is being connected? Required — connections are now per-store
  // (unique(user_id, store_id), migration 042). The callback stamps this store_id.
  if (!storeId) {
    return NextResponse.redirect(new URL('/dashboard?tiktok=error&reason=missing_store', siteUrl));
  }
  // The store must belong to the caller.
  const { data: membership } = await supabase
    .from('store_members')
    .select('store_id')
    .eq('user_id', user.id)
    .eq('store_id', storeId)
    .maybeSingle();
  if (!membership) {
    return NextResponse.redirect(new URL('/dashboard?tiktok=error&reason=invalid_store', siteUrl));
  }

  // Store state in cookie for validation on callback
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

  // And the target store, so the callback stamps store_id on the connection.
  cookieStore.set('tiktok_oauth_store', storeId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  const authUrl = getAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
