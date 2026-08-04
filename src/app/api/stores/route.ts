import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export const dynamic = 'force-dynamic';

// The user's OWNED stores (store_members) with a `connected` flag — the switcher's
// authoritative list. Includes owned-but-unconnected stores (status.stores[] only has
// connected ones), so the UI can offer a Connect action for them.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: memberships } = await supabase
    .from('store_members')
    .select('store_id')
    .eq('user_id', user.id);
  const storeIds = (memberships ?? []).map((m) => m.store_id as string);

  if (storeIds.length === 0) {
    return NextResponse.json({ stores: [], activeStore: await getActiveStore() });
  }

  const [{ data: storeRows }, { data: conns }] = await Promise.all([
    supabase.from('stores').select('id, name').in('id', storeIds),
    supabase.from('tiktok_connections').select('store_id, shop_name, shop_logo, token_expires_at').eq('user_id', user.id),
  ]);

  // needsReconnect = has a connection row but the access token is dead or within 24h of expiry.
  // Surfaced so the UI offers a NON-destructive Reconnect (in-place OAuth) instead of leaving
  // Disconnect (which DELETES all synced orders) as the only action on an expired store.
  const RECONNECT_LEAD_MS = 24 * 3600 * 1000;
  const connByStore = new Map((conns ?? []).map((c) => [c.store_id as string, c]));
  const stores = (storeRows ?? []).map((s) => {
    const conn = connByStore.get(s.id as string);
    const expMs = conn?.token_expires_at ? new Date(conn.token_expires_at as string).getTime() : 0;
    return {
      id: s.id as string,
      name: (s.name as string) ?? 'Store',
      connected: !!conn,
      needsReconnect: !!conn && (!expMs || expMs - Date.now() < RECONNECT_LEAD_MS),
      tokenExpiresAt: (conn?.token_expires_at as string) ?? null,
      shopName: (conn?.shop_name as string) ?? null,
      shopLogo: (conn?.shop_logo as string) ?? null,
    };
  });

  return NextResponse.json({ stores, activeStore: await getActiveStore() });
}

// NOTE: store creation is intentionally NOT a POST here anymore. Stores are created
// connect-first — from the TikTok OAuth result, named from the shop — in the callback
// (src/app/auth/tiktok/callback/route.ts, ?new=1 mode). There is no typed-name creation
// path, so there is exactly one store-creation flow with one naming source.
