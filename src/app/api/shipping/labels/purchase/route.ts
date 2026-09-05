import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { createPackage, ALREADY_PURCHASED_CODES } from '@/lib/tiktok/client';
import { parsePrice, readSpendWindows } from '@/lib/shipping/purchaseGuards';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST /api/shipping/labels/purchase?store_id=…&run_id=…[&limit=50]
//
// DRAIN AN AUTHORISED MANIFEST. Buys labels for the next `limit` claimed boxes of a run, in
// print order. This is the only route in the app that spends money.
//
// IT EXERCISES NO JUDGEMENT. Every decision — what is in scope, whether the plan was reviewed,
// what to do about unbound boxes — was made once at /authorize, which wrote the manifest as
// claimed rows. This route only turns claims into labels. That is deliberate: a fulfilment day
// is 474-863 boxes and takes about ten minutes of TikTok calls, so it MUST be chunked across
// requests, and a route that re-decided anything per chunk would be re-approving a run the
// operator approved once.
//
// The safety properties therefore live in the manifest, not here:
//   - a box is claimed BEFORE any call, so a crash cannot cause a re-buy;
//   - the ledger's partial unique index allows one live claim per box, so two runs cannot
//     overlap and a repeated drain cannot double-buy;
//   - the flag still gates spending, so an inert deploy stays inert even with a manifest present.

/** Boxes per request. ~50 calls fits comfortably inside the time budget with room to spare. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 120;

/**
 * Stop with this much of the budget left.
 *
 * A cut-off request is not dangerous — every purchase is already durable in the ledger — but it
 * is unobservable: the caller gets a 504 and no summary. Stopping early and reporting what
 * remains keeps every label accounted for.
 */
const TIME_BUDGET_MS = 240_000;

interface ClaimRow {
  group_key: string;
  order_ids: string[];
  ship_type: string | null;
  print_seq: number | null;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const runId = url.searchParams.get('run_id');
  const limitRaw = url.searchParams.get('limit');
  if (!storeId || !runId) {
    return NextResponse.json({ error: 'store_id and run_id are required' }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(limitRaw) || DEFAULT_LIMIT));

  if (process.env.LABEL_PURCHASE_ENABLED !== '1') {
    return NextResponse.json({
      purchased: 0, spent: 0, drained: false,
      code: 'disabled', reason: 'LABEL_PURCHASE_ENABLED is not 1 — log-only',
    });
  }

  const admin = createAdminClient();

  // The next slice of the manifest, in print order.
  const { data: claims, error: readErr } = await admin
    .from('shipping_label_purchases')
    .select('group_key, order_ids, ship_type, print_seq')
    .eq('user_id', user.id).eq('store_id', storeId).eq('run_id', runId)
    .eq('status', 'claimed')
    .order('print_seq', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  // How much of this run is still outstanding, for the caller's progress display.
  const { count: outstanding } = await admin
    .from('shipping_label_purchases')
    .select('group_key', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('store_id', storeId).eq('run_id', runId)
    .eq('status', 'claimed');

  const rows = (claims ?? []) as ClaimRow[];
  if (!rows.length) {
    return NextResponse.json({
      run_id: runId, purchased: 0, spent: 0, failed: 0, remaining: 0, done: true,
      spend_recent: await readSpendWindows(admin, user.id, storeId),
    });
  }

  const { data: conn } = await admin
    .from('tiktok_connections').select('*')
    .eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!conn) return NextResponse.json({ error: 'Store not connected' }, { status: 404 });
  const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });
  const token = fresh.accessToken as string;
  const cipher = (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string;

  const bought: Array<{ group_key: string; package_id: string; price: number | null }> = [];
  const failed: Array<{ group_key: string; code: number | null; message: string }> = [];
  let stoppedEarly = false;

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedEarly = true; break; }
    const shipType = (row.ship_type === '3' ? '3' : '1') as '1' | '3';
    // Each box is wrapped alone: one failure must not abandon a drain whose earlier purchases
    // are already paid for.
    try {
      const res = await createPackage(token, cipher, {
        shipType,
        orderId: shipType === '1' ? row.order_ids[0] : undefined,
        orderIds: shipType === '3' ? row.order_ids : undefined,
      });

      // TikTok's own idempotency guard: a label already exists. That is a COMPLETED box, not a
      // failure — marking it failed would let a later run buy a second label for one parcel.
      if (ALREADY_PURCHASED_CODES.has(res.code)) {
        await admin.from('shipping_label_purchases').update({
          status: 'purchased', purchased_at: new Date().toISOString(),
          error_code: String(res.code),
          error_message: `already purchased at TikTok: ${res.message}`,
        }).eq('user_id', user.id).eq('store_id', storeId)
          .eq('run_id', runId).eq('group_key', row.group_key);
        bought.push({ group_key: row.group_key, package_id: '', price: null });
        continue;
      }

      if (res.code !== 0 || !res.pkg?.package_id) {
        // Released for retry EXCEPT on code -1 (unparseable response): there we cannot tell
        // whether the call took effect, so the row stays claimed and blocks a re-buy until a
        // human looks. Guessing "failed" there is how a label gets bought twice.
        const releasable = res.code !== -1;
        await admin.from('shipping_label_purchases').update({
          status: releasable ? 'failed' : 'claimed',
          error_code: String(res.code), error_message: res.message.slice(0, 500),
        }).eq('user_id', user.id).eq('store_id', storeId)
          .eq('run_id', runId).eq('group_key', row.group_key);
        failed.push({ group_key: row.group_key, code: res.code, message: res.message.slice(0, 200) });
        continue;
      }

      const price = parsePrice(res.pkg.price);
      await admin.from('shipping_label_purchases').update({
        status: 'purchased', purchased_at: new Date().toISOString(),
        package_id: res.pkg.package_id,
        price_amount: price, price_currency: res.pkg.currency ?? 'USD',
        shipping_provider_name: res.pkg.shipping_provider_name,
        shipping_service_name: res.pkg.shipping_service_name,
      }).eq('user_id', user.id).eq('store_id', storeId)
        .eq('run_id', runId).eq('group_key', row.group_key);

      // No document fetch here: TikTok does not have the label ready this soon after Create
      // (measured — all five inline fetches on the 5-box run came back empty, all five worked a
      // minute later). /labels/pdf fetches it, and is the only place it is used.
      bought.push({ group_key: row.group_key, package_id: res.pkg.package_id, price });
    } catch (e) {
      // Left claimed on purpose: we do not know whether the purchase landed, and claimed is the
      // state that refuses to buy again.
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ group_key: row.group_key, code: null, message: msg.slice(0, 200) });
      console.error(`[labels/purchase] box ${row.group_key} threw; left claimed`, msg);
    }
  }

  const spent = Math.round(bought.reduce((n, b) => n + (b.price ?? 0), 0) * 100) / 100;
  const remaining = Math.max(0, (outstanding ?? rows.length) - bought.length - failed.length);
  console.log(`[labels/purchase] run ${runId}: +${bought.length} labels, $${spent}, ${remaining} left`);

  return NextResponse.json({
    run_id: runId,
    purchased: bought.length,
    spent,
    currency: 'USD',
    failed: failed.length,
    remaining,
    done: remaining === 0,
    stopped_early: stoppedEarly,
    bought,
    failed_detail: failed,
    spend_recent: await readSpendWindows(admin, user.id, storeId, spent),
  });
}
