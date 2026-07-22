import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST: BOUNDED backfill of synced_order_ids.tracking_number for rows where it is NULL.
//
// Why this exists: tracking_number was captured only while an order was AWAITING_COLLECTION
// and then null-overwritten as the order shipped (fixed forward in the sync upsert, PR #57),
// so most historical rows are null. TikTok's order-DETAIL endpoint (getOrderById) returns
// tracking_number for ALL statuses, so we can recover it directly — no Fulfillment API needed.
//
// DRY RUN BY DEFAULT ({ dry_run:true }): fetches order detail for the null-tracking target set,
// and reports how many WOULD be written + a sample, WITHOUT writing. Only { dry_run:false }
// performs the UPDATE — and only tracking_number, only where it is still NULL (COALESCE-safe:
// a stored tracking is never overwritten). Admin-guarded.
//
// Naturally re-runnable: the target set is `tracking_number IS NULL`, so each write run shrinks
// it. If a large run risks the time budget, pass `limit` to bound one invocation and re-run.
//
// Body: {
//   store_id?: uuid,                 // scope to one store; omit → all connected stores
//   statuses?: string[],             // stored statuses to target (default the two active/packable buckets)
//   dry_run?: boolean,               // default TRUE — must opt in to writing
//   sample?: number,                 // sample rows in the response (default 20, max 50)
//   limit?: number,                  // cap target order_ids processed this invocation (default 6000)
// }

const DEFAULT_STATUSES = ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT'];
// Verification anchor: the HAZMAT combined box confirmed via probe. Surfaced explicitly so a
// dry run proves the specific label gets populated.
const VERIFY_ORDER_ID = '577486698651882246';
const VERIFY_TRACKING = '9236290394220300007067';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { store_id?: string; statuses?: string[]; dry_run?: boolean; sample?: number; limit?: number };
  try { body = await req.json(); } catch { body = {}; }
  const storeFilter = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const statuses = Array.isArray(body.statuses) && body.statuses.length ? body.statuses.map(String) : DEFAULT_STATUSES;
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to writing
  const sampleN = Math.min(50, Math.max(1, Math.trunc(Number(body.sample) || 20)));
  const limit = Math.max(1, Math.trunc(Number(body.limit) || 6000));

  const admin = createAdminClient();

  // Connections to process (per-store model). Each carries its own encrypted creds.
  let connQ = admin.from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at');
  if (storeFilter) connQ = connQ.eq('store_id', storeFilter);
  const { data: conns, error: connErr } = await connQ;
  if (connErr) return NextResponse.json({ error: `connections read failed: ${connErr.message}` }, { status: 500 });
  if (!conns?.length) return NextResponse.json({ error: 'no matching TikTok connection(s)' }, { status: 400 });

  type Proposed = { order_id: string; store_id: string; live_status: string; tracking: string };
  const proposed: Proposed[] = [];
  let targetTotal = 0;      // null-tracking rows in scope
  let scanned = 0;          // order_ids we asked getOrderById about
  let noTracking = 0;       // returned by API but no tracking (e.g. pre-label / cancelled)
  let notReturned = 0;      // API didn't return the order
  const byStore: Record<string, { target: number; recoverable: number }> = {};
  let verifyHit: Record<string, unknown> | null = null;
  let budgetLeft = limit;

  for (const c of conns) {
    if (budgetLeft <= 0) break;
    const storeId = String(c.store_id);
    const ownerUserId = String(c.user_id);
    byStore[storeId] = byStore[storeId] || { target: 0, recoverable: 0 };

    // Null-tracking target order_ids for this store (paginate past the 1000-row cap).
    const ids: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await admin.from('synced_order_ids')
        .select('order_id')
        .eq('user_id', ownerUserId).eq('store_id', storeId)
        .in('status', statuses).is('tracking_number', null)
        .range(from, from + 999);
      if (error) return NextResponse.json({ error: `synced read failed: ${error.message}` }, { status: 500 });
      if (!page?.length) break;
      ids.push(...page.map((r) => String(r.order_id)));
      if (page.length < 1000) break;
    }
    const uniqueIds = [...new Set(ids)];
    targetTotal += uniqueIds.length;
    byStore[storeId].target += uniqueIds.length;

    // Bound this invocation.
    const work = uniqueIds.slice(0, budgetLeft);
    budgetLeft -= work.length;
    if (!work.length) continue;

    const connRow = c as unknown as ConnRow;
    const { accessToken: token, shopCipher: cipher } = await getFreshToken(admin, connRow, { skewMinutes: 30 });
    const returned = new Set<string>();

    for (let i = 0; i < work.length; i += 50) {
      const chunk = work.slice(i, i + 50);
      scanned += chunk.length;
      let got: Record<string, unknown>[] = [];
      try { got = await getOrderById(token as string, cipher as string, chunk); }
      catch (e) { return NextResponse.json({ error: 'getOrderById failed', detail: String(e), store_id: storeId, at: i }, { status: 502 }); }
      for (const o of got) {
        const id = String(o.id);
        returned.add(id);
        const trk = o.tracking_number ? String(o.tracking_number) : '';
        if (trk) {
          proposed.push({ order_id: id, store_id: storeId, live_status: String(o.status || ''), tracking: trk });
          byStore[storeId].recoverable += 1;
          if (id === VERIFY_ORDER_ID || trk === VERIFY_TRACKING) {
            verifyHit = { order_id: id, store_id: storeId, live_status: String(o.status || ''), tracking_to_write: trk, matches_expected: trk === VERIFY_TRACKING };
          }
        } else {
          noTracking += 1;
        }
      }
    }
    notReturned += work.filter((id) => !returned.has(id)).length;
  }

  const sample = proposed.slice(0, sampleN);
  const summary = {
    dry_run: dryRun,
    statuses,
    store_filter: storeFilter || 'ALL',
    stores: byStore,
    target_null_tracking: targetTotal,          // null-tracking rows in scope
    scanned_this_run: scanned,                  // order_ids sent to getOrderById this invocation
    would_update: proposed.length,              // recoverable — tracking returned by order detail
    returned_no_tracking: noTracking,           // pre-label / cancelled — correctly stays null
    not_returned_by_api: notReturned,
    limit_applied: limit,
    remaining_budget: budgetLeft,
    verification_target: verifyHit,             // the HAZMAT order — proves it gets populated
    sample,
  };

  if (dryRun) {
    return NextResponse.json({ ...summary, wrote: 0, note: 'DRY RUN — no rows written. Re-POST with dry_run:false to apply.' });
  }

  // ── WRITE: tracking_number only, one order at a time, guarded by `is null` so a stored
  //    tracking is never overwritten (COALESCE-safe even against a concurrent sync).
  let wrote = 0;
  for (const p of proposed) {
    const { error, count } = await admin
      .from('synced_order_ids')
      .update({ tracking_number: p.tracking }, { count: 'exact' })
      .eq('store_id', p.store_id).eq('order_id', p.order_id).is('tracking_number', null);
    if (error) console.error('[backfill-tracking] update error', p.order_id, error.message);
    else wrote += count ?? 0;
  }
  return NextResponse.json({ ...summary, wrote });
}
