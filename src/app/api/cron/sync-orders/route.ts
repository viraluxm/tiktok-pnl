import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { getOrgId } from '@/lib/org';
import { syncConnection } from '@/lib/tiktok/syncCore';
import { readAllPaged } from '@/lib/db/readAll';
import { planStatusRefresh, type OpenOrder } from '@/lib/tiktok/statusRefreshPlan';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Server-side sync heartbeat — runs regardless of anyone having a dashboard open (the root fix for a
// store running a live and landing zero orders). Three ORDERED phases, ONE shared time budget:
//
//   A. ORDERS   — shared syncConnection() from @/lib/tiktok/syncCore: the SAME verified watermark +
//                 48h re-scan + checkpoint day loop the interactive route runs. No second
//                 implementation → no drift. Most-stale store first (a fat store can't starve the
//                 others — that's what left lotsofsteals 20h behind).
//   B. STATUS   — refresh open-order statuses via getOrderById (a create_time sync never re-fetches
//                 an older order whose status changed). Must run AFTER A (new orders exist first).
//   C. TRACKING — fill/correct tracking on the now-current pack-ready set, AWAITING_COLLECTION first
//                 (labels bought → productive detail calls). Must run AFTER B (tracking can only fill
//                 rows that exist, in their current status).
//
// LOG-ONLY RAMP: CRON_SYNC_WRITE must be exactly 'true' to write. Default = dry run — every phase
// still READS (real load + would-write volume measurable) and writes NOTHING. Runs a day, then flip.
// A manual admin trigger may pass {write:true} to test end-to-end.

const TIME_BUDGET_MS = 240_000;   // shared across all phases + stores, < maxDuration
const CHUNK = 50;                 // getOrderById max ids/call
const CALL_CAP_STATUS = 120;      // getOrderById calls/run, status phase
// Split of CALL_CAP_STATUS between the newest open orders and the oldest. See
// lib/tiktok/statusRefreshPlan.ts: selecting oldest-first left everything past the row cap
// PERMANENTLY unrefreshed, and inverting it would only move the blind spot to the tail.
const STATUS_CALLS_RECENT = 100;
const STATUS_CALLS_BACKLOG = 20;
const CALL_CAP_TRACKING = 120;    // getOrderById calls/run, tracking phase
const MAX_RL_RETRIES = 3;
const CORE_OPEN = ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'ON_HOLD', 'PARTIALLY_SHIPPING'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (m: string) => /429|rate ?-?limit|too many|too frequent|frequent|105005/i.test(m);
const overBudget = (started: number) => Date.now() - started >= TIME_BUDGET_MS;
type Admin = ReturnType<typeof createAdminClient>;
type Conn = ConnRow & { store_id: string; user_id: string };

async function detailWithBackoff(token: string, cipher: string, ids: string[]): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await getOrderById(token, cipher, ids); }
    catch (e) { const msg = String(e); if (isRateLimit(msg) && attempt < MAX_RL_RETRIES) { await sleep(1000 * (attempt + 1)); continue; } throw e; }
  }
}

// ── Phase B: refresh open-order statuses (newest-first + an oldest slice), one store ──
async function refreshStatuses(admin: Admin, conn: Conn, write: boolean, started: number) {
  const { store_id: storeId, user_id: userId } = conn;
  const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
  const token = fresh.accessToken as string, cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;
  let calls = 0, examined = 0, wouldUpdate = 0, updated = 0, error: string | null = null;
  // WAS: one read, `order_created_at` ascending, `.limit(CALL_CAP_STATUS * CHUNK)` = 6,000.
  // Two defects compounded. PostgREST clamps a response to 1000 rows, so that limit silently
  // yielded the oldest 1,000 — and Snore has 13,014 open orders, meaning 12,014 were never
  // refreshed at all. Not eventually: never, because every run re-selected the same oldest
  // 1,000. Today's orders are the newest, so they sat permanently in the blind spot while the
  // oldest 1,000 — measured to be unchanging — were re-polled every 30 minutes.
  //
  // Now: two PAGED reads from opposite ends, merged by planStatusRefresh. Most of the budget
  // goes to the newest orders, where transitions actually happen; a deliberate slice goes to
  // the oldest so no part of the open set is ever unreachable.
  const readEnd = (ascending: boolean, calls: number) => readAllPaged<OpenOrder & { status: string }>(
    (from, to) => admin.from('synced_order_ids')
      .select('order_id, status, order_created_at')
      .eq('user_id', userId).eq('store_id', storeId).in('status', CORE_OPEN)
      .order('order_created_at', { ascending, nullsFirst: false })
      .order('order_id', { ascending: true })
      .range(from, Math.min(to, calls * CHUNK - 1)),
    `sync-orders status ${ascending ? 'backlog' : 'recent'} ${storeId}`,
  );

  const [recentRows, backlogRows] = await Promise.all([
    readEnd(false, STATUS_CALLS_RECENT),
    readEnd(true, STATUS_CALLS_BACKLOG),
  ]);

  // Total open count for an honest "not reached this run" figure. A server-side count returns
  // no rows, so it is immune to the very cap that caused this bug.
  const { count: openTotal } = await admin.from('synced_order_ids')
    .select('order_id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('store_id', storeId).in('status', CORE_OPEN);

  const stored = new Map<string, string>();
  for (const r of [...recentRows, ...backlogRows]) stored.set(String(r.order_id), String(r.status));

  const plan = planStatusRefresh(
    [...recentRows, ...backlogRows].map((r) => ({
      order_id: String(r.order_id),
      order_created_at: r.order_created_at ?? null,
    })),
    { chunk: CHUNK, recentCalls: STATUS_CALLS_RECENT, backlogCalls: STATUS_CALLS_BACKLOG },
  );
  const ids = plan.ids;
  const notReached = Math.max(0, (openTotal ?? 0) - ids.length);
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (overBudget(started) || calls >= CALL_CAP_STATUS) break;
      const got = await detailWithBackoff(token, cipher, ids.slice(i, i + CHUNK)); calls++;
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
      examined += Math.min(CHUNK, ids.length - i); if (error) break; await sleep(80);
    }
  } catch (e) { error = String(e); }
  return {
    store_id: storeId, calls, examined, would_update: wouldUpdate, updated, error,
    // Surfaced so a growing blind spot is visible in the run log rather than inferred months
    // later from a number that looked wrong.
    open_total: openTotal ?? null,
    planned: ids.length,
    recent: plan.recentCount,
    backlog: plan.backlogCount,
    not_reached: notReached,
  };
}

// ── Phase C: fill/correct tracking on the pack-ready set (AWAITING_COLLECTION first), one store ──
async function fillTracking(admin: Admin, conn: Conn, write: boolean, started: number) {
  const { store_id: storeId, user_id: userId } = conn;
  const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
  const token = fresh.accessToken as string, cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;
  let calls = 0, examined = 0, wouldFill = 0, filled = 0, wouldCorrect = 0, corrected = 0, noLabel = 0, error: string | null = null;
  const { data: rows } = await admin.from('synced_order_ids')
    .select('order_id, tracking_number, auto_combine_group_id, status')
    .eq('user_id', userId).eq('store_id', storeId).in('status', CORE_OPEN)
    .order('order_id', { ascending: true }).limit(CALL_CAP_TRACKING * CHUNK);
  // AWAITING_COLLECTION first (labels bought → productive), then the rest of the open set.
  const sorted = (rows ?? []).slice().sort((a, b) => (a.status === 'AWAITING_COLLECTION' ? 0 : 1) - (b.status === 'AWAITING_COLLECTION' ? 0 : 1));
  const stored = new Map(sorted.map((r) => [String(r.order_id), { trk: (r.tracking_number as string | null) ?? null, grp: (r.auto_combine_group_id as string | null) ?? null }]));
  const ids = [...stored.keys()];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (overBudget(started) || calls >= CALL_CAP_TRACKING) break;
      const got = await detailWithBackoff(token, cipher, ids.slice(i, i + CHUNK)); calls++;
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
      examined += Math.min(CHUNK, ids.length - i); await sleep(80);
    }
  } catch (e) { error = String(e); }
  return { store_id: storeId, calls, examined, would_fill: wouldFill, filled, would_correct: wouldCorrect, corrected, no_label: noLabel, error };
}

// GET, not POST: Vercel cron jobs invoke the endpoint with a GET request (matches every other cron
// in this app). A POST-only handler is never called by the scheduler.
export async function GET(req: Request) {
  const started = Date.now();
  // Auth: Vercel cron (Bearer CRON_SECRET) OR a logged-in admin. Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) authorized = true;
  else { const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (user?.app_metadata?.role === 'admin') authorized = true; }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Write override for a manual admin trigger (?write=true). The scheduled cron uses CRON_SYNC_WRITE.
  const write = process.env.CRON_SYNC_WRITE === 'true' || new URL(req.url).searchParams.get('write') === 'true';

  const admin = createAdminClient();
  // select('*') — syncConnection reads sync_cursor / sync_page_cursor / sync_progress_day /
  // sync_progress_orders / sync_rescan_at off the row; a narrow column list left them undefined, so
  // every store looked never-synced and re-backfilled 365 days (watermark never engaged). Match the
  // interactive route, which passes the full connection. Most-stale store FIRST (last_synced_at asc).
  const { data: conns, error: connErr } = await admin.from('tiktok_connections')
    .select('*')
    .order('last_synced_at', { ascending: true, nullsFirst: true });
  if (connErr || !conns?.length) return NextResponse.json({ error: 'no connections' }, { status: connErr ? 500 : 404 });

  const orders: unknown[] = [], statuses: unknown[] = [], tracking: unknown[] = [];
  const orgCache = new Map<string, string | null>();
  const usersTouched = new Set<string>();

  // Phase A: ORDERS (shared syncConnection). Most-stale first. Can't pack what isn't synced → first.
  for (const c of conns) {
    if (overBudget(started)) break;
    if (!c.shop_cipher) { orders.push({ store_id: c.store_id, skipped: 'no_shop_cipher' }); continue; }
    try {
      if (!orgCache.has(c.user_id)) orgCache.set(c.user_id, await getOrgId(admin, c.user_id));
      orders.push(await syncConnection(admin, c as Record<string, unknown>, c.user_id, orgCache.get(c.user_id) ?? null, started, { write }));
      usersTouched.add(c.user_id);
    } catch (e) { orders.push({ store_id: c.store_id, error: String(e) }); }
  }
  // Rebuild USER-level entries once per touched user (write mode only — dry run persists nothing).
  if (write) for (const uid of usersTouched) { const { error } = await admin.rpc('rebuild_entries', { p_user_id: uid }); if (error) console.error('[cron] rebuild_entries', uid, error.message); }

  // Phase B: STATUS, if budget remains.
  for (const c of conns) { if (overBudget(started)) break; if (!c.shop_cipher) continue; try { statuses.push(await refreshStatuses(admin, c as Conn, write, started)); } catch (e) { statuses.push({ store_id: c.store_id, error: String(e) }); } }
  // Phase C: TRACKING, if budget remains.
  for (const c of conns) { if (overBudget(started)) break; if (!c.shop_cipher) continue; try { tracking.push(await fillTracking(admin, c as Conn, write, started)); } catch (e) { tracking.push({ store_id: c.store_id, error: String(e) }); } }

  const summary = { write, mode: write ? 'WRITE' : 'DRY-RUN (log-only ramp)', ms: Date.now() - started, budget_exhausted: overBudget(started), stores: conns.length, orders, statuses, tracking };
  console.log('[cron/sync-orders]', JSON.stringify(summary));
  // Telemetry (both modes): persist the run summary so the log-only ramp's would-write + read-load
  // numbers are queryable. Not order data — a dry run still persists nothing of consequence.
  await admin.from('cron_sync_runs').insert({ is_write: write, summary }).then(({ error }) => { if (error) console.error('[cron] log insert', error.message); });
  return NextResponse.json(summary);
}
