import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getActiveStore } from '@/lib/tiktok/activeStore';
import { getOrgId } from '@/lib/org';

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

// Create a new store the caller owns (Phase E). The OAuth connect path already works
// once a store row + membership exist, so this just provisions those two rows.
// Writes go through the admin client (RLS is bypassed) mirroring the callback route,
// which validates ownership in code rather than via RLS.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const name = typeof (body as { name?: unknown })?.name === 'string'
    ? (body as { name: string }).name.trim()
    : '';
  if (!name) return NextResponse.json({ error: 'Store name is required' }, { status: 400 });

  const admin = createAdminClient();

  // Same org-derivation the rest of the app uses (SHARED tables are org-scoped).
  const orgId = await getOrgId(admin, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization found for user' }, { status: 400 });

  // Insert the store. UNIQUE(org_id, name) → clean 409 instead of a 500.
  // slug is nullable and currently unused (existing rows have slug = null), so leave it null.
  const { data: store, error: storeError } = await admin
    .from('stores')
    .insert({ org_id: orgId, name })
    .select('id, name')
    .single();

  if (storeError) {
    if (storeError.code === '23505') {
      return NextResponse.json({ error: 'A store with that name already exists' }, { status: 409 });
    }
    console.error('Failed to create store:', storeError);
    return NextResponse.json({ error: 'Failed to create store' }, { status: 500 });
  }

  // Add the caller as owner. If this fails, delete the just-created store so we
  // don't orphan a store row with no members.
  const { error: memberError } = await admin
    .from('store_members')
    .insert({ store_id: store.id, user_id: user.id, role: 'owner' });

  if (memberError) {
    console.error('Failed to add store membership, rolling back store:', memberError);
    await admin.from('stores').delete().eq('id', store.id);
    return NextResponse.json({ error: 'Failed to create store' }, { status: 500 });
  }

  return NextResponse.json({
    store: { id: store.id as string, name: store.name as string, connected: false, shopName: null, shopLogo: null },
  }, { status: 201 });
}
