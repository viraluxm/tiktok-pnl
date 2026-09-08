import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCancellations, fetchReturns, type TikTokReturn } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { blocksPacking } from '@/lib/shipping/refundGuard';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Refund/cancellation ingest → order_refund_state (migration 133).
//
// This is the feed for the pack guard. Nothing in Lensed knew about refunds before: parseOrder
// captures no refund field, so a refunded order sitting in AWAITING_COLLECTION looked perfectly
// packable and would have shipped. See migration 133 for the incident.
//
// Reads TikTok, writes ONE table that no live-show path touches. Safe to run mid-show.
//
// GET/POST ?days=30[&store_id=…][&dry_run=1]
//   Auth: Vercel cron (Bearer CRON_SECRET) or a logged-in user, never public — matching
//   /api/cron/sync-orders.
//
// WHY A WINDOW: both endpoints are time-ranged on the refund's own update time, so a window that
// is too short misses a refund raised today against an August order. 30 days is the default
// because that is roughly where TikTok's own auto-refund lands for a late dispatch, which is the
// case that caused the incident.

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

/**
 * ConnRow is the token contract only (id, access_token, refresh_token, shop_cipher, expiry). This
 * route also needs the owner and shop it belongs to, so the selected shape is named here rather
 * than cast through ConnRow.
 */
type Conn = ConnRow & { user_id: string; store_id: string | null };

interface Row {
  user_id: string; store_id: string | null; order_id: string; kind: string;
  ref_id: string | null; status: string; blocks_packing: boolean;
  return_type: string | null; reason: string | null; refund_amount: number | null;
  tiktok_created_at: string | null; tiktok_updated_at: string | null;
}

function toRows(
  recs: TikTokReturn[], kind: 'cancellation' | 'return', userId: string, storeId: string | null,
): Row[] {
  // One row per (order, kind): keep the MOST RECENTLY UPDATED record when an order has several,
  // because the guard asks about the current state, not the history.
  const byOrder = new Map<string, Row>();
  for (const r of recs) {
    const orderId = String(r.order_id ?? '');
    if (!orderId) continue;
    const status = String(r.status ?? '');
    const upd = Number(r.update_time) || 0;
    const existing = byOrder.get(orderId);
    if (existing && Date.parse(existing.tiktok_updated_at ?? '') / 1000 >= upd) continue;
    byOrder.set(orderId, {
      user_id: userId,
      store_id: storeId,
      order_id: orderId,
      kind,
      ref_id: String(r.return_id ?? '') || null,
      status,
      // The raw status is stored beside this so a wrong call stays visible and re-derivable.
      blocks_packing: blocksPacking(status),
      return_type: String(r.return_type ?? '') || null,
      reason: String(r.return_reason_text ?? r.return_reason ?? '') || null,
      refund_amount: Number.isFinite(Number(r.refund_amount)) ? Number(r.refund_amount) : null,
      tiktok_created_at: r.create_time ? new Date(Number(r.create_time) * 1000).toISOString() : null,
      tiktok_updated_at: upd ? new Date(upd * 1000).toISOString() : null,
    });
  }
  return [...byOrder.values()];
}

async function run(req: Request) {
  const url = new URL(req.url);
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) authorized = true;
  if (!authorized) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) authorized = true;
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_DAYS));
  const onlyStore = url.searchParams.get('store_id');
  const dryRun = url.searchParams.get('dry_run') === '1';

  const admin = createAdminClient();
  let q = admin.from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at');
  if (onlyStore) q = q.eq('store_id', onlyStore);
  const { data: conns, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86_400;
  const perStore: Array<Record<string, unknown>> = [];

  for (const conn of (conns ?? []) as Conn[]) {
    const storeId = conn.store_id ?? null;
    const userId = conn.user_id;
    try {
      const fresh = await getFreshToken(admin, conn, { skewMinutes: 30 });
      const token = fresh.accessToken as string;
      const cipher = (fresh.shopCipher ?? conn.shop_cipher) as string;

      // Both endpoints, because a "cancellation" and a "return/refund" are different records and
      // either one means the parcel must not go out.
      const [cancels, returns] = await Promise.all([
        fetchCancellations(token, cipher, startTs, endTs).catch(() => [] as TikTokReturn[]),
        fetchReturns(token, cipher, startTs, endTs).catch(() => [] as TikTokReturn[]),
      ]);

      const rows = [
        ...toRows(cancels, 'cancellation', userId, storeId),
        ...toRows(returns, 'return', userId, storeId),
      ];
      const blocking = rows.filter((r) => r.blocks_packing).length;

      if (!dryRun && rows.length) {
        // Chunked: an upsert of thousands of rows in one call is a needlessly large statement.
        for (let i = 0; i < rows.length; i += 500) {
          const { error: upErr } = await admin.from('order_refund_state')
            .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,order_id,kind' });
          if (upErr) throw new Error(upErr.message);
        }
      }

      // How many of these are sitting in the pack-ready pile RIGHT NOW — the number that says
      // whether this guard is preventing anything today.
      let packReadyBlocked = 0;
      const blockingIds = rows.filter((r) => r.blocks_packing).map((r) => r.order_id);
      for (let i = 0; i < blockingIds.length; i += 200) {
        const { count } = await admin.from('synced_order_ids')
          .select('order_id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .in('order_id', blockingIds.slice(i, i + 200))
          .in('status', ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT']);
        packReadyBlocked += count ?? 0;
      }

      perStore.push({
        store_id: storeId,
        cancellations: cancels.length,
        returns: returns.length,
        rows_written: dryRun ? 0 : rows.length,
        blocking: blocking,
        pack_ready_and_blocked: packReadyBlocked,
      });
    } catch (e) {
      perStore.push({ store_id: storeId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    dry_run: dryRun,
    window_days: days,
    stores: perStore,
    pack_ready_and_blocked_total: perStore.reduce(
      (n, s) => n + (Number(s.pack_ready_and_blocked) || 0), 0),
  });
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
