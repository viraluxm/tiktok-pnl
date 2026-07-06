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
    supabase.from('tiktok_connections').select('store_id, shop_name, shop_logo').eq('user_id', user.id),
  ]);

  const connByStore = new Map((conns ?? []).map((c) => [c.store_id as string, c]));
  const stores = (storeRows ?? []).map((s) => {
    const conn = connByStore.get(s.id as string);
    return {
      id: s.id as string,
      name: (s.name as string) ?? 'Store',
      connected: !!conn,
      shopName: (conn?.shop_name as string) ?? null,
      shopLogo: (conn?.shop_logo as string) ?? null,
    };
  });

  return NextResponse.json({ stores, activeStore: await getActiveStore() });
}
