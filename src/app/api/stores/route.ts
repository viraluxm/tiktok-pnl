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
    supabase.from('tiktok_connections').select('store_id, shop_name, shop_logo, connected_at, refresh_token_expires_at').eq('user_id', user.id),
  ]);

  // Re-auth deadline = the refresh token's operational lifetime (issuance + 28d — see
  // expiriesFromToken; TikTok's own refresh expiry is a useless ~2125). Warn WARN_MS before it,
  // surfaced via needsReconnect + reconnectBy so the UI shows "Reconnect by <date>" and offers the
  // non-destructive in-place OAuth (never leaving Disconnect — which DELETES all synced orders — as
  // the only action). Deadline source: the stored refresh_token_expires_at when it's a real value;
  // else (null or the year-2125 unit-bug value) fall back to connected_at + 28d (connected_at is
  // reliable and moves on every reconnect).
  const WARN_MS = 5 * 86_400_000;
  const TTL_MS = 28 * 86_400_000;
  const BUG_FAR_FUTURE_MS = Date.now() + 366 * 86_400_000;
  const connByStore = new Map((conns ?? []).map((c) => [c.store_id as string, c]));
  const stores = (storeRows ?? []).map((s) => {
    const conn = connByStore.get(s.id as string);
    const stored = conn?.refresh_token_expires_at ? new Date(conn.refresh_token_expires_at as string).getTime() : 0;
    const connMs = conn?.connected_at ? new Date(conn.connected_at as string).getTime() : 0;
    const deadlineMs = stored && stored < BUG_FAR_FUTURE_MS ? stored : (connMs ? connMs + TTL_MS : 0);
    return {
      id: s.id as string,
      name: (s.name as string) ?? 'Store',
      connected: !!conn,
      needsReconnect: !!conn && (!deadlineMs || deadlineMs - Date.now() < WARN_MS),
      reconnectBy: deadlineMs ? new Date(deadlineMs).toISOString() : null,
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
