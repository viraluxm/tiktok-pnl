import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST: BOUNDED backfill of synced_order_ids.order_created_at from TikTok's real
// order create_time (migration 051). create_time was never persisted, so the value
// MUST be re-fetched from TikTok — this route does that, scoped to ONE store + ONE
// date range at a time (never an unbounded whole-table pass).
//
// DRY RUN BY DEFAULT ({ dry_run:true }): fetches the window, matches order_ids to
// existing synced rows, and returns a before/after sample + counts WITHOUT writing.
// Only { dry_run:false } performs the UPDATE (order_created_at only — order_date and
// every other column are untouched). Admin-guarded.
//
// Body: { store_id: uuid, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', dry_run?: boolean, sample?: number }

const SHOP_TIMEZONE = 'America/Los_Angeles';

// YYYY-MM-DD → unix seconds at shop-tz midnight (mirrors sync/route.ts dayToTs).
function dayToTs(day: string): number {
  const refUtc = new Date(day + 'T12:00:00Z');
  const utcDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const localDateStr = refUtc.toLocaleDateString('en-CA', { timeZone: SHOP_TIMEZONE });
  const utcHours = refUtc.getUTCHours();
  const localHours = parseInt(refUtc.toLocaleTimeString('en-GB', { timeZone: SHOP_TIMEZONE, hour: '2-digit', hour12: false }));
  let offsetHours = utcHours - localHours;
  if (utcDateStr !== localDateStr) offsetHours += utcDateStr > localDateStr ? 24 : -24;
  return Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) + offsetHours * 3600;
}
function advanceDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { store_id?: string; start?: string; end?: string; dry_run?: boolean; sample?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const storeId = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const start = typeof body.start === 'string' ? body.start.trim() : '';
  const end = typeof body.end === 'string' ? body.end.trim() : '';
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to writing
  const sampleN = Math.min(50, Math.max(1, Math.trunc(Number(body.sample) || 20)));
  const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!storeId || !isYmd(start) || !isYmd(end) || start > end) {
    return NextResponse.json({ error: 'store_id, start (YYYY-MM-DD), end (YYYY-MM-DD) required; start <= end' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Connection for this store (per-store model, migration 042).
  const { data: conn } = await admin
    .from('tiktok_connections')
    .select('user_id, shop_cipher, access_token')
    .eq('store_id', storeId).maybeSingle();
  if (!conn?.access_token || !conn?.shop_cipher) {
    return NextResponse.json({ error: 'No TikTok connection for that store' }, { status: 400 });
  }
  const ownerUserId = conn.user_id as string;
  const token = decryptOrFallback(conn.access_token as string, 'access_token');
  const cipher = conn.shop_cipher as string;

  // ── Re-fetch create_time from TikTok for [start, end] (day loop + page cursor,
  //    mirroring the sync writer). Bounded to the requested range only.
  const createTimeByOrder = new Map<string, number>();
  let pagesFetched = 0;
  for (let day = start; day <= end; day = advanceDay(day)) {
    const ge = dayToTs(day);
    const lt = dayToTs(advanceDay(day));
    let pageToken: string | null = null;
    let pageNum = 0;
    do {
      if (pageNum >= 500) break; // safety cap (25k orders/day)
      pageNum++; pagesFetched++;
      const { orders, nextCursor } = await fetchOrdersPage(token, cipher, ge, lt, pageToken);
      for (const o of orders as Record<string, unknown>[]) {
        const oid = String(o.id || '');
        const ct = Number(o.create_time) || 0;
        if (oid && ct) createTimeByOrder.set(oid, ct);
      }
      pageToken = nextCursor;
    } while (pageToken);
  }

  // ── Existing synced rows for this store+window (order_date bounds the same range).
  interface Row { order_id: string; order_date: string | null; order_created_at: string | null }
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('synced_order_ids')
      .select('order_id, order_date, order_created_at')
      .eq('user_id', ownerUserId).eq('store_id', storeId)
      .gte('order_date', start).lte('order_date', end)
      .order('order_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: `synced read failed: ${error.message}` }, { status: 500 });
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  const toIso = (ct: number) => new Date(ct * 1000).toISOString();
  const matched = rows.filter((r) => createTimeByOrder.has(r.order_id));
  const sample = matched.slice(0, sampleN).map((r) => ({
    order_id: r.order_id,
    order_date: r.order_date,
    current_order_created_at: r.order_created_at,
    proposed_order_created_at: toIso(createTimeByOrder.get(r.order_id)!),
  }));

  const summary = {
    dry_run: dryRun,
    store_id: storeId,
    window: { start, end },
    pages_fetched: pagesFetched,
    fetched_orders: createTimeByOrder.size,
    synced_rows_in_window: rows.length,
    matched_rows: matched.length,
    synced_not_fetched: rows.length - matched.length, // in our DB but TikTok didn't return (cancelled-purged, etc.)
    sample,
  };

  if (dryRun) {
    return NextResponse.json({ ...summary, wrote: 0, note: 'DRY RUN — no rows written. Re-POST with dry_run:false to apply.' });
  }

  // ── WRITE: order_created_at only, one order_id at a time (bounded to matched set).
  let wrote = 0;
  for (const r of matched) {
    const { error } = await admin
      .from('synced_order_ids')
      .update({ order_created_at: toIso(createTimeByOrder.get(r.order_id)!) })
      .eq('user_id', ownerUserId).eq('store_id', storeId).eq('order_id', r.order_id);
    if (error) console.error('[backfill-created-at] update error', r.order_id, error.message);
    else wrote++;
  }
  return NextResponse.json({ ...summary, wrote });
}
