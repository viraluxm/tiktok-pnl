import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrdersPage, getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { parseOrder, upsertOrderRows } from '@/lib/tiktok/orderRows';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ── Server-side sync heartbeat: syncs orders for ALL stores on a schedule, independent of anyone
// having a dashboard open. Root fix for "a store ran a full live and landed zero orders" — order
// sync was client-driven, so a store whose operator never opened the P&L view went stale (Snore
// 07-31, lotsofsteals 19h). Runs three phases IN ORDER per invocation, sharing one time budget:
//
//   A. ORDERS   — INCREMENTAL WATERMARK. Fetches create_time_ge = (max order_created_at for the
//                 store − OVERLAP) forward to now. Only new orders, not the whole day → avoids the
//                 naive "re-sync today" that would re-upsert ~100k+ rows/day (the resolve-channels
//                 write pattern). The watermark self-checkpoints via the upserted rows: a run that
//                 only gets partway advances max(order_created_at), so the next run continues — no
//                 cursor column, no migration. A big backlog (store days behind) drains over runs.
//   B. STATUS   — a create_time-bounded order sync NEVER re-fetches an older order whose status
//                 changed, and status drives the pack-ready set. So refresh open-order statuses via
//                 the detail endpoint (getOrderById), oldest-open-first. Without this a scheduled
//                 job would let AWAITING_SHIPMENT → AWAITING_COLLECTION go unnoticed.
//   C. TRACKING — fill/correct tracking on the now-current pack-ready set. AWAITING_COLLECTION first
//                 (those definitionally have labels bought → productive detail calls; no-label
//                 orders waste a call slot).
//
// LOG-ONLY RAMP: CRON_SYNC_WRITE must be exactly 'true' to write. Default = dry run: every phase
// still READS (measure the real Disk IO + would-write volume), writes NOTHING. Flip the env after a
// day of watching IO. A manual admin trigger may pass {write:true} to test end-to-end.
//
// OVERLAP (index-lag guard): bounding on max(order_created_at) risks PERMANENTLY skipping any order
// TikTok indexes late — invisible forever, no error. TikTok's real search-index lag is undetermined
// from our data, so we err generous: 60 min. Redundant re-fetch of the overlap window each run is
// bounded and cheap; a silent gap is not. Tighten only with evidence.

const OVERLAP_MS = 60 * 60 * 1000;                 // 60-min index-lag guard (err toward redundant fetch)
const BACKFILL_MS = 365 * 24 * 60 * 60 * 1000;     // first-ever sync reaches back a year
const TIME_BUDGET_MS = 240_000;                    // shared across all phases + stores, < maxDuration
const PAGE_CAP = 200;                              // per-store safety cap on order-search pages/run
const CALL_CAP_STATUS = 120;                       // getOrderById calls/run for the status phase
const CALL_CAP_TRACKING = 120;                     // getOrderById calls/run for the tracking phase
const CHUNK = 50;                                  // getOrderById max ids/call
const MAX_RL_RETRIES = 3;
const CORE_OPEN = ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'ON_HOLD', 'PARTIALLY_SHIPPING'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (m: string) => /429|rate ?-?limit|too many|too frequent|frequent|105005/i.test(m);
const overBudget = (started: number) => Date.now() - started >= TIME_BUDGET_MS;

type Admin = ReturnType<typeof createAdminClient>;

// getOrderById with rate-limit backoff. Returns [] rows on a non-throttle error via `throw` so the
// caller can stop that phase cleanly (partial progress kept), mirroring the sync-tracking net.
async function detailWithBackoff(token: string, cipher: string, ids: string[]): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await getOrderById(token, cipher, ids); }
    catch (e) {
      const msg = String(e);
      if (isRateLimit(msg) && attempt < MAX_RL_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}
async function pageWithBackoff(token: string, cipher: string, sTs: number, eTs: number, pageToken: string | null) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetchOrdersPage(token, cipher, sTs, eTs, pageToken); }
    catch (e) {
      const msg = String(e);
      if (isRateLimit(msg) && attempt < MAX_RL_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

// ── Phase A: incremental watermark order sync for one store ──
async function syncOrders(admin: Admin, conn: ConnRow & { store_id: string; user_id: string }, write: boolean, started: number) {
  const storeId = conn.store_id;
  const userId = conn.user_id;
  const { data: wm } = await admin.from('synced_order_ids')
    .select('order_created_at').eq('store_id', storeId)
    .not('order_created_at', 'is', null).order('order_created_at', { ascending: false }).limit(1);
  const latestMs = wm?.[0]?.order_created_at ? new Date(wm[0].order_created_at as string).getTime() : null;
  const startTs = Math.floor((latestMs ? latestMs - OVERLAP_MS : Date.now() - BACKFILL_MS) / 1000);
  const endTs = Math.floor(Date.now() / 1000);

  const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
  const token = fresh.accessToken as string;
  const cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;

  let pageToken: string | null = null, pages = 0, fetched = 0, wouldWrite = 0, written = 0;
  let budgetCut = false; let error: string | null = null;
  try {
    do {
      if (overBudget(started) || pages >= PAGE_CAP) { budgetCut = true; break; }
      const { orders, nextCursor } = await pageWithBackoff(token, cipher, startTs, endTs, pageToken);
      pages++; fetched += orders.length;
      if (orders.length) {
        const byId = new Map<string, Record<string, unknown>>();
        for (const o of orders) { const p = parseOrder(userId, o as Record<string, unknown>); const id = String(p.order_id || ''); if (id) byId.set(id, p); }
        const rows = [...byId.values()];
        wouldWrite += rows.length;
        if (write) { const r = await upsertOrderRows(admin, storeId, rows); if (r.error) { error = r.error; break; } written += r.written; }
      }
      pageToken = nextCursor;
    } while (pageToken);
  } catch (e) { error = String(e); }
  return { store_id: storeId, from_ts: startTs, pages, fetched, would_write: wouldWrite, written, done: !pageToken && !budgetCut && !error, budget_cut: budgetCut, error };
}

// ── Phase B: refresh statuses of open orders (oldest-open-first), one store ──
async function refreshStatuses(admin: Admin, conn: ConnRow & { store_id: string; user_id: string }, write: boolean, started: number) {
  const storeId = conn.store_id, userId = conn.user_id;
  const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
  const token = fresh.accessToken as string, cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;
  let calls = 0, examined = 0, wouldUpdate = 0, updated = 0, error: string | null = null;
  const { data: rows } = await admin.from('synced_order_ids')
    .select('order_id, status').eq('user_id', userId).eq('store_id', storeId).in('status', CORE_OPEN)
    .order('order_created_at', { ascending: true, nullsFirst: false }).limit(CALL_CAP_STATUS * CHUNK);
  const stored = new Map((rows ?? []).map((r) => [String(r.order_id), String(r.status)]));
  const ids = [...stored.keys()];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (overBudget(started) || calls >= CALL_CAP_STATUS) break;
      const chunk = ids.slice(i, i + CHUNK);
      const got = await detailWithBackoff(token, cipher, chunk); calls++;
      for (const o of got) {
        const id = String(o.id); const from = stored.get(id); if (from === undefined) continue;
        const to = String(o.status || '').toUpperCase(); if (!to || to === from) continue;
        wouldUpdate++;
        if (write) {
          const { error: e, count } = await admin.from('synced_order_ids').update({ status: to }, { count: 'exact' })
            .eq('store_id', storeId).eq('order_id', id).neq('status', to);
          if (e) { error = e.message; break; } updated += count ?? 0;
        }
      }
      examined += chunk.length; if (error) break; await sleep(80);
    }
  } catch (e) { error = String(e); }
  return { store_id: storeId, calls, examined, would_update: wouldUpdate, updated, error };
}

// ── Phase C: fill/correct tracking on the pack-ready set (AWAITING_COLLECTION first), one store ──
async function fillTracking(admin: Admin, conn: ConnRow & { store_id: string; user_id: string }, write: boolean, started: number) {
  const storeId = conn.store_id, userId = conn.user_id;
  const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
  const token = fresh.accessToken as string, cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;
  let calls = 0, examined = 0, wouldFill = 0, filled = 0, wouldCorrect = 0, corrected = 0, noLabel = 0, error: string | null = null;
  // AWAITING_COLLECTION first (labels bought → productive), then the rest of the open set, then order_id.
  const { data: rows } = await admin.from('synced_order_ids')
    .select('order_id, tracking_number, auto_combine_group_id, status')
    .eq('user_id', userId).eq('store_id', storeId).in('status', CORE_OPEN)
    .order('status', { ascending: true }).order('order_id', { ascending: true }).limit(CALL_CAP_TRACKING * CHUNK);
  // Sort AWAITING_COLLECTION to the front explicitly (alpha order doesn't guarantee it).
  const sorted = (rows ?? []).slice().sort((a, b) =>
    (a.status === 'AWAITING_COLLECTION' ? 0 : 1) - (b.status === 'AWAITING_COLLECTION' ? 0 : 1));
  const stored = new Map(sorted.map((r) => [String(r.order_id), { trk: (r.tracking_number as string | null) ?? null, grp: (r.auto_combine_group_id as string | null) ?? null }]));
  const ids = [...stored.keys()];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (overBudget(started) || calls >= CALL_CAP_TRACKING) break;
      const chunk = ids.slice(i, i + CHUNK);
      const got = await detailWithBackoff(token, cipher, chunk); calls++;
      for (const o of got) {
        const id = String(o.id); const trk = o.tracking_number ? String(o.tracking_number).trim() : '';
        if (!trk) { noLabel++; continue; }
        const s = stored.get(id); const oldTrk = s?.trk ?? null; if (oldTrk === trk) continue;
        if (oldTrk === null) {
          wouldFill++;
          if (write) { const { count } = await admin.from('synced_order_ids').update({ tracking_number: trk }, { count: 'exact' }).eq('store_id', storeId).eq('order_id', id).is('tracking_number', null); filled += count ?? 0; }
        } else {
          wouldCorrect++;
          if (write) {
            const { count } = await admin.from('synced_order_ids').update({ tracking_number: trk }, { count: 'exact' }).eq('store_id', storeId).eq('order_id', id).eq('tracking_number', oldTrk);
            if ((count ?? 0) > 0) { corrected += count ?? 0; await admin.from('tracking_correction_log').insert({ user_id: userId, store_id: storeId, order_id: id, old_tracking: oldTrk, new_tracking: trk, combine_group_id: s?.grp ?? null, source: 'cron' }); }
          }
        }
      }
      examined += chunk.length; await sleep(80);
    }
  } catch (e) { error = String(e); }
  return { store_id: storeId, calls, examined, would_fill: wouldFill, filled, would_correct: wouldCorrect, corrected, no_label: noLabel, error };
}

export async function POST(req: Request) {
  const started = Date.now();
  // Auth: Vercel cron (Bearer CRON_SECRET) OR a logged-in admin (manual trigger). Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) authorized = true;
  else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.role === 'admin') authorized = true;
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { write?: boolean };
  // Log-only ramp: env is the source of truth; a manual admin call may force write:true to test.
  const write = process.env.CRON_SYNC_WRITE === 'true' || body.write === true;

  const admin = createAdminClient();
  const { data: conns, error: connErr } = await admin.from('tiktok_connections')
    .select('id, user_id, store_id, shop_name, access_token, refresh_token, shop_cipher, token_expires_at')
    .order('last_synced_at', { ascending: true, nullsFirst: true });   // most-stale store first
  if (connErr || !conns?.length) return NextResponse.json({ error: 'no connections' }, { status: connErr ? 500 : 404 });

  const orders: unknown[] = [], statuses: unknown[] = [], tracking: unknown[] = [];
  // Phase A: orders for every store (priority — can't pack what isn't synced).
  for (const c of conns) {
    if (overBudget(started)) break;
    if (!c.shop_cipher) { orders.push({ store_id: c.store_id, skipped: 'no_shop_cipher' }); continue; }
    try { orders.push(await syncOrders(admin, c as ConnRow & { store_id: string; user_id: string }, write, started)); }
    catch (e) { orders.push({ store_id: c.store_id, error: String(e) }); }
    if (write) await admin.from('tiktok_connections').update({ last_synced_at: new Date().toISOString() }).eq('id', c.id);
  }
  // Phase B: statuses, if budget remains.
  for (const c of conns) { if (overBudget(started)) break; if (!c.shop_cipher) continue; try { statuses.push(await refreshStatuses(admin, c as ConnRow & { store_id: string; user_id: string }, write, started)); } catch (e) { statuses.push({ store_id: c.store_id, error: String(e) }); } }
  // Phase C: tracking, if budget remains.
  for (const c of conns) { if (overBudget(started)) break; if (!c.shop_cipher) continue; try { tracking.push(await fillTracking(admin, c as ConnRow & { store_id: string; user_id: string }, write, started)); } catch (e) { tracking.push({ store_id: c.store_id, error: String(e) }); } }

  const summary = { write, mode: write ? 'WRITE' : 'DRY-RUN (log-only ramp)', ms: Date.now() - started, budget_exhausted: overBudget(started), stores: conns.length, orders, statuses, tracking };
  console.log('[cron/sync-orders]', JSON.stringify(summary));
  return NextResponse.json(summary);
}
