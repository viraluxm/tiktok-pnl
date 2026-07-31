import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export const dynamic = 'force-dynamic';

const MAX_NAME_LEN = 80;

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

// Create a new store the caller owns. This is the product entry point that used to be
// done by hand in prod. Writes with the service-role client because RLS on stores /
// store_members is disabled out-of-band and unverified — never rely on it here.
//
// Two-step write (stores → store_members) with a compensating delete: a store with no
// member is invisible in the switcher and unrecoverable through the UI, so a failed
// membership insert must roll the store back rather than leave it orphaned.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { name?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Store name is required' }, { status: 400 });
  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: `Store name must be ${MAX_NAME_LEN} characters or fewer` }, { status: 400 });
  }

  const admin = createAdminClient();

  // stores.org_id is NOT NULL with no default; a store must live under the caller's org.
  const orgId = await getOrgId(admin, user.id);
  if (!orgId) {
    return NextResponse.json({ error: 'You must belong to an organization to create a store' }, { status: 400 });
  }

  // Reject a duplicate the caller already owns (case-insensitive), before hitting the DB's
  // stricter case-sensitive UNIQUE(org_id, name). Only checks the caller's OWN stores — no
  // global name uniqueness across orgs.
  const { data: memberships } = await admin
    .from('store_members')
    .select('store_id')
    .eq('user_id', user.id);
  const ownedIds = (memberships ?? []).map((m) => m.store_id as string);
  if (ownedIds.length > 0) {
    const { data: ownedStores } = await admin
      .from('stores')
      .select('name')
      .in('id', ownedIds);
    const lower = name.toLowerCase();
    if ((ownedStores ?? []).some((s) => (s.name as string ?? '').toLowerCase() === lower)) {
      return NextResponse.json({ error: `You already have a store named "${name}"` }, { status: 409 });
    }
  }

  // 1. Create the store (id / slug / created_at / updated_at all default).
  const { data: store, error: storeErr } = await admin
    .from('stores')
    .insert({ org_id: orgId, name })
    .select('id, name')
    .single();
  if (storeErr || !store) {
    // 23505 = unique_violation on UNIQUE(org_id, name) — another store in the org already
    // holds this exact name (possibly one the caller doesn't own → the check above missed it).
    if (storeErr?.code === '23505') {
      return NextResponse.json({ error: `A store named "${name}" already exists in your organization` }, { status: 409 });
    }
    console.error('[stores POST] store insert failed:', storeErr);
    return NextResponse.json({ error: 'Failed to create store' }, { status: 500 });
  }

  // 2. Link the caller as owner (role matches the existing owner rows, not the 'operator' default).
  const { error: memberErr } = await admin
    .from('store_members')
    .insert({ store_id: store.id, user_id: user.id, role: 'owner' });
  if (memberErr) {
    // 3. Compensate: never leave a store with no member. Delete the store we just made.
    console.error('[stores POST] member insert failed, rolling back store:', store.id, memberErr);
    const { error: delErr } = await admin.from('stores').delete().eq('id', store.id);
    if (delErr) {
      console.error('[stores POST] compensating delete FAILED — orphaned store:', store.id, delErr);
      return NextResponse.json(
        { error: 'Failed to create store membership and could not clean up', orphanedStoreId: store.id },
        { status: 500 },
      );
    }
    console.log('[stores POST] compensating delete succeeded for store:', store.id);
    return NextResponse.json({ error: 'Failed to create store' }, { status: 500 });
  }

  return NextResponse.json({ id: store.id, name: store.name, connected: false }, { status: 201 });
}
