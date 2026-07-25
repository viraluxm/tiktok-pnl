import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Packer-facing tracking recovery — a one-click pre-flight after label purchase. Recovers
// synced_order_ids.tracking_number (which decays: fresh orders arrive NULL until synced, and
// label-barcode scanning only works when it's stored). Same recovery as the admin backfill route,
// but NON-ADMIN: gated by store_members membership and scoped to ONE store. Writes tracking_number
// ONLY, COALESCE-safe (never overwrites an existing value). Off the auction path → safe any time.
//
// GET  ?store_id=…  → coverage for the store (total_ac, with_tracking, missing_tracking).
// POST { store_id, dry_run?, after? } → recover a bounded chunk (keyset by order_id). Re-invoke
//   with `next_after` until done. `dry_run` (default true) reports would-write without writing.

const TARGET_STATUSES = ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT'];
const CALL_BUDGET = 80;          // 80 × 50-id calls ≈ 4000 orders/invocation, < maxDuration
const TIME_BUDGET_MS = 240_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Caller must be a member of the store (the app's existing store-access gate). Returns the store's
// connection (owner + creds) via the service role — the store's data owner may not be the caller.
async function authorizeStore(storeId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!storeId) return { error: NextResponse.json({ error: 'store_id required' }, { status: 400 }) };
  const { data: member } = await supabase.from('store_members').select('store_id').eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!member) return { error: NextResponse.json({ error: 'No access to this store' }, { status: 403 }) };
  const admin = createAdminClient();
  const { data: conn } = await admin.from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at').eq('store_id', storeId).maybeSingle();
  return { admin, conn: (conn ?? null) as ConnRow | null, ownerId: conn ? String(conn.user_id) : null };
}

export async function GET(req: Request) {
  const storeId = new URL(req.url).searchParams.get('store_id')?.trim() ?? '';
  const a = await authorizeStore(storeId);
  if (a.error) return a.error;
  const { admin, ownerId } = a;
  if (!ownerId) return NextResponse.json({ error: 'no TikTok connection for store' }, { status: 400 });
  // Coverage is measured on the packable AWAITING_COLLECTION set (the label-bought orders scanning depends on).
  const base = () => admin.from('synced_order_ids').select('order_id', { count: 'exact', head: true })
    .eq('user_id', ownerId).eq('store_id', storeId).eq('status', 'AWAITING_COLLECTION');
  const { count: total } = await base();
  const { count: withTrk } = await base().not('tracking_number', 'is', null);
  return NextResponse.json({ store_id: storeId, total_ac: total ?? 0, with_tracking: withTrk ?? 0, missing_tracking: (total ?? 0) - (withTrk ?? 0) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { store_id?: string; dry_run?: boolean; after?: string };
  const storeId = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const dryRun = body.dry_run !== false; // default TRUE
  const after = typeof body.after === 'string' ? body.after : '';

  const a = await authorizeStore(storeId);
  if (a.error) return a.error;
  const { admin, conn, ownerId } = a;
  if (!conn || !ownerId) return NextResponse.json({ error: 'no TikTok connection for store' }, { status: 400 });

  const started = Date.now();
  let token = '', cipher = '', tokenLoaded = false;
  let calls = 0, examined = 0, updated = 0, noLabel = 0, notReturned = 0, budgetExhausted = false;
  let cursor = after;

  outer: while (true) {
    if (calls >= CALL_BUDGET || Date.now() - started >= TIME_BUDGET_MS) { budgetExhausted = true; break; }
    // Keyset page of null-tracking target orders (order_id lexicographic), store-scoped.
    const { data: page, error } = await admin.from('synced_order_ids')
      .select('order_id')
      .eq('user_id', ownerId).eq('store_id', storeId).in('status', TARGET_STATUSES).is('tracking_number', null)
      .gt('order_id', cursor).order('order_id', { ascending: true }).limit(1000);
    if (error) return NextResponse.json({ error: `read failed: ${error.message}` }, { status: 500 });
    if (!page?.length) break;

    if (!tokenLoaded) {
      const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
      token = fresh.accessToken as string; cipher = (fresh.shopCipher ?? conn.shop_cipher) as string; tokenLoaded = true;
    }

    const ids = page.map((r) => String(r.order_id));
    for (let i = 0; i < ids.length; i += 50) {
      if (calls >= CALL_BUDGET || Date.now() - started >= TIME_BUDGET_MS) { budgetExhausted = true; break outer; }
      const chunk = ids.slice(i, i + 50);
      let got: Record<string, unknown>[] = [];
      try { got = await getOrderById(token, cipher, chunk); }
      catch (e) { return NextResponse.json({ error: 'getOrderById failed', detail: String(e) }, { status: 502 }); }
      calls++;
      const returned = new Set<string>();
      for (const o of got) {
        const id = String(o.id); returned.add(id);
        const trk = o.tracking_number ? String(o.tracking_number) : '';
        if (!trk) { noLabel++; continue; }              // label not bought yet — a normal outcome
        if (dryRun) { updated++; continue; }
        // WRITE: tracking_number ONLY, guarded is-null (COALESCE-safe), this store only.
        const { count } = await admin.from('synced_order_ids')
          .update({ tracking_number: trk }, { count: 'exact' })
          .eq('store_id', storeId).eq('order_id', id).is('tracking_number', null);
        updated += count ?? 0;
      }
      examined += chunk.length;
      notReturned += chunk.filter((id) => !returned.has(id)).length;
      cursor = chunk[chunk.length - 1];
      await sleep(60);
    }
    if (page.length < 1000) break;
  }

  // Remaining null-tracking orders still ahead of the cursor (drives the UI's resume loop).
  const { count: remaining } = await admin.from('synced_order_ids')
    .select('order_id', { count: 'exact', head: true })
    .eq('user_id', ownerId).eq('store_id', storeId).in('status', TARGET_STATUSES).is('tracking_number', null)
    .gt('order_id', cursor || '');

  return NextResponse.json({
    dry_run: dryRun, store_id: storeId,
    examined, updated, no_label: noLabel, not_returned: notReturned,
    remaining: remaining ?? 0, next_after: (remaining ?? 0) > 0 ? cursor : null,
    done: (remaining ?? 0) === 0,
    note: dryRun ? 'DRY RUN — nothing written.' : 'tracking_number recovered (COALESCE-safe).',
    budget: { calls, ms_used: Date.now() - started, exhausted: budgetExhausted },
  });
}
