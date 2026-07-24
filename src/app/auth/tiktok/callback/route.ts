import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCodeForToken, getAuthorizedShops } from '@/lib/tiktok/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { encrypt } from '@/lib/crypto';
import { expiriesFromToken } from '@/lib/tiktok/tokens';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // TikTok Shop OAuth returns 'code'
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const cookieStore = await cookies();
  const savedState = cookieStore.get('tiktok_oauth_state')?.value;
  const userId = cookieStore.get('tiktok_oauth_user')?.value;
  const storeId = cookieStore.get('tiktok_oauth_store')?.value;

  // Clear OAuth cookies
  cookieStore.delete('tiktok_oauth_state');
  cookieStore.delete('tiktok_oauth_user');
  cookieStore.delete('tiktok_oauth_store');

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

  // storeId is OPTIONAL now:
  //   • present  → RE-AUTH an existing store (validated below, defense-in-depth).
  //   • absent   → CONNECT A NEW SHOP: create/dedup a store from the TikTok shop
  //                id and link a store_membership (onboarding + add-Nth-shop).

  try {
    // Exchange code for access token via TikTok Shop API (retry once on failure)
    let tokenData;
    try {
      tokenData = await exchangeCodeForToken(code);
    } catch (firstErr) {
      console.warn('[TikTok callback] First token exchange failed, retrying in 2s:', (firstErr as Error).message);
      await new Promise(r => setTimeout(r, 2000));
      tokenData = await exchangeCodeForToken(code);
    }

    // Get authorized shops — shop_cipher is required for all Shop API calls,
    // shop_id is the STABLE dedup key.
    let shopId: string | null = null;
    let shopCipher: string | null = null;
    let shopName: string | null = null;
    let logoUrl: string | null = null;
    const shops = await getAuthorizedShops(tokenData.access_token);
    console.log('[TikTok callback] getAuthorizedShops returned:', JSON.stringify(shops));
    if (shops.length > 0) {
      shopId = shops[0].shop_id || null;
      shopCipher = shops[0].shop_cipher;
      shopName = shops[0].shop_name;
      logoUrl = shops[0].logo_url;
      console.log('[TikTok callback] Using shop:', shopName, 'id:', shopId, 'cipher:', shopCipher);
    } else {
      console.error('[TikTok callback] No authorized shops found — sync will not work');
    }

    // All store/membership/connection writes use the admin client (bypasses RLS).
    const adminClient = createAdminClient();

    // Resolve the store this connection attaches to.
    let targetStoreId: string;

    if (storeId) {
      // RE-AUTH: re-validate the target store belongs to this user.
      const { data: membership } = await adminClient
        .from('store_members')
        .select('store_id')
        .eq('user_id', userId)
        .eq('store_id', storeId)
        .maybeSingle();
      if (!membership) {
        console.error('TikTok callback: store not owned by user', { userId, storeId });
        return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=invalid_store`);
      }
      targetStoreId = storeId;
    } else {
      // CONNECT NEW SHOP → create/dedup the store, then link membership.
      // 1. Ensure the user has an org (idempotent SECURITY DEFINER RPC).
      const { data: orgId, error: orgErr } = await adminClient.rpc('ensure_user_org', {
        p_user: userId,
        p_name: null,
      });
      if (orgErr || !orgId) {
        console.error('TikTok callback: ensure_user_org failed', orgErr);
        return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=org_error`);
      }

      // 2. Dedup: reuse an existing store for this (org, TikTok shop id).
      //    Falls back to (org, name) when TikTok returned no shop id, so we still
      //    avoid an obvious duplicate.
      let existing: { id: string } | null = null;
      if (shopId) {
        const { data } = await adminClient
          .from('stores')
          .select('id')
          .eq('org_id', orgId)
          .eq('tiktok_shop_id', shopId)
          .maybeSingle();
        existing = data ?? null;
      } else if (shopName) {
        const { data } = await adminClient
          .from('stores')
          .select('id')
          .eq('org_id', orgId)
          .eq('name', shopName)
          .is('tiktok_shop_id', null)
          .maybeSingle();
        existing = data ?? null;
      }

      if (existing) {
        targetStoreId = existing.id;
        // Refresh name/logo/shop_id in case they changed since last connect.
        await adminClient
          .from('stores')
          .update({ name: shopName || undefined, logo_url: logoUrl, tiktok_shop_id: shopId })
          .eq('id', targetStoreId);
      } else {
        const { data: created, error: storeErr } = await adminClient
          .from('stores')
          .insert({
            org_id: orgId,
            name: shopName || 'TikTok Shop',
            tiktok_shop_id: shopId,
            logo_url: logoUrl,
          })
          .select('id')
          .single();
        if (storeErr || !created) {
          console.error('TikTok callback: store create failed', storeErr);
          return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=store_error`);
        }
        targetStoreId = created.id;
      }

      // 3. Link the user to the store as owner (idempotent).
      const { error: memErr } = await adminClient
        .from('store_members')
        .upsert({ store_id: targetStoreId, user_id: userId, role: 'owner' }, { onConflict: 'store_id,user_id' });
      if (memErr) {
        console.error('TikTok callback: store_member link failed', memErr);
        return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=member_error`);
      }
    }

    // access_token_expire_in / refresh_token_expire_in are ABSOLUTE Unix epoch seconds —
    // NOT durations. Use them directly; adding Date.now() double-counts the epoch and
    // yields a year-~2081 expiry (the incident that silently disabled token refresh).
    const { token_expires_at, refresh_token_expires_at } = expiriesFromToken(tokenData);

    // Per-store connection: upsert on (user_id, store_id) so re-authing one store
    // updates only that store's row and never clobbers another store's connection.
    const { error: upsertError } = await adminClient
      .from('tiktok_connections')
      .upsert({
        user_id: userId,
        store_id: targetStoreId,
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        token_expires_at,
        refresh_token_expires_at,
        shop_cipher: shopCipher,
        shop_name: shopName || tokenData.seller_name || 'TikTok Shop',
        connected_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,store_id',
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
