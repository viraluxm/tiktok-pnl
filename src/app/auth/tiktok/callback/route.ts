import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCodeForToken, getAuthorizedShops } from '@/lib/tiktok/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { encrypt } from '@/lib/crypto';
import { expiriesFromToken } from '@/lib/tiktok/tokens';
import { getOrgId } from '@/lib/org';
import { ACTIVE_STORE_COOKIE } from '@/lib/tiktok/activeStore';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // TikTok Shop OAuth returns 'code'
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const cookieStore = await cookies();
  const savedState = cookieStore.get('tiktok_oauth_state')?.value;
  const userId = cookieStore.get('tiktok_oauth_user')?.value;
  const storeId = cookieStore.get('tiktok_oauth_store')?.value;
  const isNew = cookieStore.get('tiktok_oauth_new')?.value === '1';

  // Clear OAuth cookies (step 9: tiktok_oauth_new is cleared on EVERY exit path — clearing it
  // here, before any branch returns, guarantees that).
  cookieStore.delete('tiktok_oauth_state');
  cookieStore.delete('tiktok_oauth_user');
  cookieStore.delete('tiktok_oauth_store');
  cookieStore.delete('tiktok_oauth_new');

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

  // ══ CONNECT-FIRST (new-store) branch ═══════════════════════════════════════════════════
  // The store does not exist yet; it is created FROM the shop the user just authorized, named
  // from shop_name. Every failure names its cause and writes nothing it can't clean up. The
  // auth code is already spent, so the order below matters (exchange → shops → decide → write).
  if (isNew) {
    // Build error/success redirects that always name the actual cause (no generic errors).
    const fail = (reason: string, message: string, extra?: Record<string, string>) => {
      const p = new URLSearchParams({ tiktok: 'error', reason, message });
      if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return NextResponse.redirect(`${origin}/dashboard?${p.toString()}`);
    };
    const ACTIVE_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 365 };

    try {
      // 1. Exchange code → tokens (retry once, mirroring the reconnect path).
      let tokenData;
      try {
        tokenData = await exchangeCodeForToken(code);
      } catch (firstErr) {
        console.warn('[TikTok callback:new] First token exchange failed, retrying in 2s:', (firstErr as Error).message);
        await new Promise((r) => setTimeout(r, 2000));
        tokenData = await exchangeCodeForToken(code);
      }

      // 2. Which shop(s) did the account authorize?
      const shops = await getAuthorizedShops(tokenData.access_token);
      console.log('[TikTok callback:new] getAuthorizedShops returned:', JSON.stringify(shops));

      // 3. Zero shops → nothing to connect. No writes.
      if (shops.length === 0) {
        return fail('no_shop', 'TikTok returned no authorized shop for this account. Authorize a shop in TikTok Seller Center, then connect again. No store was created.');
      }

      // 4. Multiple shops → DELIBERATELY unsupported for now (a shop picker is future work).
      //    We do NOT fall back to shops[0]: silently picking one is exactly the wrong-store bug
      //    we are avoiding. No writes; list the shop names so the user knows what was seen.
      if (shops.length > 1) {
        const names = shops.map((s) => s.shop_name || '(unnamed shop)').join(', ');
        return fail('multi_shop', `This TikTok account is authorized for multiple shops (${names}). Connecting a multi-shop account isn't supported yet — a shop picker is coming. No store was created.`);
      }

      // 5. Exactly one shop. shop_id is the idempotency key — refuse to create without one.
      const shop = shops[0];
      if (!shop.shop_id) {
        return fail('missing_shop_id', `TikTok did not return a shop id for "${shop.shop_name || 'this shop'}", so it can't be connected safely (shop_id is the identity key). No store was created.`);
      }

      const admin = createAdminClient();
      const { token_expires_at, refresh_token_expires_at } = expiriesFromToken(tokenData);
      // Connection fields shared by every write below (same set the reconnect path writes,
      // plus shop_logo). user_id/store_id are added per-write.
      const connFields = {
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        token_expires_at,
        refresh_token_expires_at,
        shop_cipher: shop.shop_cipher,
        shop_name: shop.shop_name,
        shop_id: shop.shop_id,
        shop_logo: shop.logo_url,
        connected_at: new Date().toISOString(),
      };

      // 6. IDEMPOTENCY: is this shop_id already connected (to ANY user)? If so, do NOT create
      //    a second store — attach this user to the existing store and refresh its tokens.
      const { data: existingConn } = await admin
        .from('tiktok_connections')
        .select('store_id')
        .eq('shop_id', shop.shop_id)
        .limit(1)
        .maybeSingle();

      if (existingConn?.store_id) {
        const existingStoreId = existingConn.store_id as string;
        const { data: existingStore } = await admin.from('stores').select('name').eq('id', existingStoreId).maybeSingle();
        const storeName = (existingStore?.name as string) || 'an existing store';

        // Upsert THIS user's connection row for that store so their tokens refresh. No store created.
        const { error: upErr } = await admin
          .from('tiktok_connections')
          .upsert({ user_id: userId, store_id: existingStoreId, ...connFields }, { onConflict: 'user_id,store_id' });
        if (upErr) {
          console.error('[TikTok callback:new] reconnect upsert failed:', upErr);
          return fail('reconnect_failed', `The shop is already connected to "${storeName}", but saving your connection failed: ${upErr.message}`, { existing_store_id: existingStoreId });
        }

        // Ensure a membership exists (owner if absent); never change an existing role.
        const { data: mem } = await admin
          .from('store_members').select('role').eq('user_id', userId).eq('store_id', existingStoreId).maybeSingle();
        if (!mem) {
          const { error: memErr } = await admin.from('store_members').insert({ store_id: existingStoreId, user_id: userId, role: 'owner' });
          if (memErr) {
            console.error('[TikTok callback:new] membership insert failed for existing store:', memErr);
            return fail('membership_failed', `The shop is already connected to "${storeName}", but adding you as a member failed: ${memErr.message}`, { existing_store_id: existingStoreId });
          }
        }

        cookieStore.set(ACTIVE_STORE_COOKIE, existingStoreId, ACTIVE_COOKIE_OPTS);
        const p = new URLSearchParams({ tiktok: 'connected', reason: 'already_connected', message: `This shop was already connected to "${storeName}". You now have access to it.` });
        return NextResponse.redirect(`${origin}/dashboard?${p.toString()}`);
      }

      // 7. New shop for us. It needs an org (stores.org_id NOT NULL) and a free name in that org.
      const orgId = await getOrgId(admin, userId);
      if (!orgId) {
        return fail('no_org', 'You must belong to an organization to connect a store. No store was created.');
      }
      // UNIQUE(org_id, name) would reject a dup — check first so we can name the culprit and
      // refuse to attach/rename (two shops, one name is a conflict the user must resolve).
      const { data: nameClash } = await admin
        .from('stores').select('id').eq('org_id', orgId).eq('name', shop.shop_name).maybeSingle();
      if (nameClash?.id) {
        return fail('name_taken', `A different store named "${shop.shop_name}" already exists in your organization. No store was created — rename the existing store or contact support.`, { existing_store_id: nameClash.id as string });
      }

      // Insert stores(org_id, name=shop_name).
      const { data: newStore, error: storeErr } = await admin
        .from('stores').insert({ org_id: orgId, name: shop.shop_name }).select('id').single();
      if (storeErr || !newStore) {
        if (storeErr?.code === '23505') {
          return fail('name_taken', `A store named "${shop.shop_name}" already exists in your organization. No store was created.`);
        }
        console.error('[TikTok callback:new] store insert failed:', storeErr);
        return fail('store_create_failed', `Could not create the store "${shop.shop_name}": ${storeErr?.message || 'unknown error'}. No store was created.`);
      }
      const newStoreId = newStore.id as string;

      // Insert store_members(store_id, user_id, owner). On failure, delete the store (never
      // leave a memberless store). If the delete ALSO fails, surface the orphaned store_id.
      const { error: memberErr } = await admin
        .from('store_members').insert({ store_id: newStoreId, user_id: userId, role: 'owner' });
      if (memberErr) {
        console.error('[TikTok callback:new] member insert failed, rolling back store:', newStoreId, memberErr);
        const { error: delErr } = await admin.from('stores').delete().eq('id', newStoreId);
        if (delErr) {
          console.error('[TikTok callback:new] compensating delete FAILED — orphaned store:', newStoreId, delErr);
          return fail('orphaned_store', `Created the store but could not add you as a member or clean up. A store row was left behind and needs manual deletion.`, { orphaned_store_id: newStoreId });
        }
        return fail('membership_failed', `Could not add you as a member of the new store: ${memberErr.message}. The store was rolled back; nothing was left behind.`);
      }

      // 8. Upsert the connection. On failure, compensating-delete BOTH rows (member then store)
      //    so no connectionless store is left behind.
      const { error: connErr } = await admin
        .from('tiktok_connections')
        .upsert({ user_id: userId, store_id: newStoreId, ...connFields }, { onConflict: 'user_id,store_id' });
      if (connErr) {
        console.error('[TikTok callback:new] connection upsert failed, rolling back store+member:', newStoreId, connErr);
        await admin.from('store_members').delete().eq('store_id', newStoreId).eq('user_id', userId);
        const { error: delErr } = await admin.from('stores').delete().eq('id', newStoreId);
        if (delErr) {
          console.error('[TikTok callback:new] compensating delete FAILED — orphaned store:', newStoreId, delErr);
          return fail('orphaned_store', `Created the store but could not save the connection or clean up. A store row was left behind and needs manual deletion.`, { orphaned_store_id: newStoreId });
        }
        return fail('connection_failed', `Could not save the TikTok connection: ${connErr.message}. The new store was rolled back; nothing was left behind.`);
      }

      // 10. Land the user on their new store.
      cookieStore.set(ACTIVE_STORE_COOKIE, newStoreId, ACTIVE_COOKIE_OPTS);
      return NextResponse.redirect(`${origin}/dashboard?tiktok=connected`);
    } catch (error) {
      // Token exchange / network failure. Cookies (incl. tiktok_oauth_new) already cleared above.
      console.error('[TikTok callback:new] error:', error);
      return fail('token_exchange', `Could not complete the TikTok connection: ${(error as Error).message}. No store was created.`);
    }
  }

  // Connections are per-store (unique(user_id, store_id), store_id NOT NULL).
  // The auth route set this cookie after validating membership; re-check here
  // (defense-in-depth) before stamping it on the connection.
  if (!storeId) {
    console.error('No store ID found in cookie');
    return NextResponse.redirect(`${origin}/dashboard?tiktok=error&reason=missing_store`);
  }

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

    // Get authorized shops — shop_cipher is required for all Shop API calls
    let shopCipher: string | null = null;
    let shopName: string | null = null;
    let shopId: string | null = null;
    const shops = await getAuthorizedShops(tokenData.access_token);
    console.log('[TikTok callback] getAuthorizedShops returned:', JSON.stringify(shops));
    if (shops.length > 0) {
      shopCipher = shops[0].shop_cipher;
      shopName = shops[0].shop_name;
      shopId = shops[0].shop_id;
      console.log('[TikTok callback] Using shop:', shopName, 'cipher:', shopCipher);
    } else {
      console.error('[TikTok callback] No authorized shops found — sync will not work');
    }

    // Store connection in database using admin client (bypasses RLS)
    const adminClient = createAdminClient();

    // Re-validate the target store belongs to this user (admin client bypasses RLS,
    // so check explicitly) before stamping the connection.
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
        store_id: storeId,
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        token_expires_at,
        refresh_token_expires_at,
        shop_cipher: shopCipher,
        shop_name: shopName || tokenData.seller_name || 'TikTok Shop',
        shop_id: shopId,
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
