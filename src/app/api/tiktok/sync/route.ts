import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { getActiveStore } from '@/lib/tiktok/activeStore';
import { syncConnection, TIME_BUDGET_MS } from '@/lib/tiktok/syncCore';

export const maxDuration = 60;

// Interactive order sync (dashboard-driven). The watermark + 48h re-scan + checkpoint day loop lives
// in @/lib/tiktok/syncCore (syncConnection) — shared verbatim with the scheduled cron so there is no
// second implementation to drift against. This route just resolves auth + the active store, loops
// the in-scope connections (writes), and rebuilds entries once.
export async function POST() {
  const batchStart = Date.now();

  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = data.user.id;

  const admin = createAdminClient();
  const orgId = await getOrgId(admin, userId);

  // Per-store connections; active store from the cookie decides scope. Oldest cursor first so the
  // most-behind store gets the budget first (avoids starving a store in 'all' mode).
  const activeStore = await getActiveStore();
  let cq = admin.from('tiktok_connections').select('*').eq('user_id', userId)
    .order('sync_cursor', { ascending: true, nullsFirst: true });
  if (activeStore !== 'all') cq = cq.eq('store_id', activeStore);
  const { data: connections, error: connError } = await cq;
  if (connError || !connections || connections.length === 0) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  }

  const perStore: Array<Record<string, unknown>> = [];
  for (const connection of connections) {
    if (Date.now() - batchStart >= TIME_BUDGET_MS) break; // shared budget across stores
    if (!connection.shop_cipher) { perStore.push({ store_id: connection.store_id, skipped: 'no_shop_cipher' }); continue; }
    try {
      perStore.push(await syncConnection(admin, connection, userId, orgId, batchStart) as unknown as Record<string, unknown>);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[Sync] store ${connection.store_id} failed:`, msg);
      // Never leave a failed store silent. syncConnection already parked the cursor + wrote a
      // day-specific sync_error on a fetch abort; this catch-all surfaces any OTHER failure too.
      await admin.from('tiktok_connections').update({
        sync_started_at: null, sync_error: msg.slice(0, 500), sync_error_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('store_id', connection.store_id);
      perStore.push({ store_id: connection.store_id, error: 'sync_failed', isCaughtUp: false, message: msg });
    }
  }

  // Entries are USER-level daily aggregates — rebuild once after all in-scope stores synced.
  const { data: rebuildCount, error: rebuildErr } = await admin.rpc('rebuild_entries', { p_user_id: userId });
  if (rebuildErr) console.error('[Rebuild] Error:', rebuildErr.message);

  const isCaughtUp = perStore.every((s) => s.isCaughtUp !== false);
  const ordersThisBatch = perStore.reduce((a, s) => a + (Number(s.ordersThisBatch) || 0), 0);
  const totalUniqueOrders = perStore.reduce((a, s) => a + (Number(s.totalUniqueOrders) || 0), 0);

  console.log(`[Sync] DONE ${perStore.length} store(s): +${ordersThisBatch} orders, entries=${rebuildCount || 0}, caught_up=${isCaughtUp}, ${Date.now() - batchStart}ms`);

  return NextResponse.json({
    success: true,
    summary: {
      isCaughtUp, totalUniqueOrders, ordersThisBatch,
      entriesCreated: rebuildCount || 0, elapsedMs: Date.now() - batchStart,
      stores: perStore, currentDay: perStore[0]?.currentDay ?? null,
    },
  });
}
