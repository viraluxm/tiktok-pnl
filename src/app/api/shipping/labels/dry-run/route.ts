import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { planPageSequence } from '@/lib/shipping/labelPlan';
import {
  resolveLabelRun, applyHealed, shipTypeFor, VerifyFailedError, MIN_ORDER_AGE_HOURS,
} from '@/lib/shipping/labelRun';
import { MAX_BOXES_PER_RUN, estimateSpend } from '@/lib/shipping/purchaseGuards';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// GET /api/shipping/labels/dry-run?store_id=…[&heal=1]
//
// What a label run WOULD buy, and the order it would print. Buys nothing.
//
// THIS IS THE ONLY APPROVAL GATE THERE CAN BE. Create Packages buys the label outright —
// tested on Snore 2026-09-03, one call moved an order AWAITING_SHIPMENT ->
// AWAITING_COLLECTION, issued tracking and made the document downloadable, with no Ship call.
// The response carries a price, but by the time it is readable the money is spent. So there is
// no "quote, approve, then buy" sequence available: a human reads THIS, then authorises the
// purchase run, and the two must agree — which is why both call resolveLabelRun.
//
// `heal=1` writes corrected statuses back for the orders it checked — the same write the sync
// cron makes, on precisely the orders we care about, in two calls instead of a 240s sweep.
// OFF by default: a thing called "dry run" should not write.

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const heal = url.searchParams.get('heal') === '1';
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });

  const admin = createAdminClient();

  const { data: conn } = await admin
    .from('tiktok_connections').select('*')
    .eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!conn) return NextResponse.json({ error: 'Store not connected' }, { status: 404 });

  const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });

  let run;
  try {
    run = await resolveLabelRun(admin, {
      userId: user.id,
      storeId,
      accessToken: fresh.accessToken as string,
      shopCipher: (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string,
      tag: 'dry-run',
    });
  } catch (e) {
    if (e instanceof VerifyFailedError) {
      return NextResponse.json(
        { error: `Could not verify order statuses with TikTok: ${e.message}`, verified: false },
        { status: 502 },
      );
    }
    throw e;
  }

  if (heal && run.healed.length) await applyHealed(admin, user.id, storeId, run.healed);

  // Which boxes are already in the ledger, so a re-read after a partial run shows what is left
  // rather than re-proposing what was bought.
  const { data: ledger } = await admin
    .from('shipping_label_purchases')
    .select('group_key, status')
    .eq('user_id', user.id).eq('store_id', storeId)
    .neq('status', 'failed')
    .in('group_key', run.boxes.map((b) => b.group_key));
  const alreadyBought = new Set((ledger ?? []).map((r: { group_key: string }) => r.group_key));

  const plan = run.plan;
  const toBuy = run.boxes.filter((b) => !alreadyBought.has(b.group_key));
  const spend = await estimateSpend(admin, user.id, storeId, toBuy.length);

  return NextResponse.json({
    dry_run: true,
    purchased: 0,
    store_id: storeId,
    verified_against_tiktok: true,
    healed: heal ? run.healed.length : 0,
    heal_available: !heal && run.healed.length > 0 ? run.healed.length : 0,
    counts: {
      candidates_in_lensed: run.candidateCount,
      candidate_boxes: run.candidateBoxCount,
      // Held back because the combine group may still be growing — the primary safety gate.
      excluded_too_recent: run.excludedTooRecent,
      min_order_age_hours: MIN_ORDER_AGE_HOURS,
      excluded_show_live: run.excludedShowLive,
      verified: run.verifiedCount,
      not_verified_over_cap: run.notVerifiedOverCap,
      confirmed_label_ready: run.confirmedCount,
      boxes: plan.totalBoxes,
      orders: plan.totalOrders,
      batched_boxes: plan.batchedBoxes,
      bundle_boxes: plan.bundles.length,
      sku_batches: plan.batches.length,
      // Distinguishes "nothing could batch" from "these could have, but each was alone".
      demoted_singletons: plan.demotedSingletons,
      demoted_skus: plan.demotedSkus,
      // Boxes a purchase run would actually buy: the plan minus anything already in the ledger.
      already_in_ledger: alreadyBought.size,
      would_buy: toBuy.length,
      one_order_boxes: toBuy.filter((b) => shipTypeFor(b) === '1').length,
      multi_order_boxes: toBuy.filter((b) => shipTypeFor(b) === '3').length,
    },
    // Spend is ESTIMATED, never quoted: no TikTok endpoint prices a label without buying it.
    spend_estimate: spend,
    max_boxes_per_run: MAX_BOXES_PER_RUN,
    // Pass BOTH of these to the purchase route to authorise a run:
    //   ?confirm_boxes= proves the plan has not moved since this was read
    //   ?limit=         states the most boxes that call may buy, and is REQUIRED
    // suggested_limit is only a suggestion. A smaller limit is always safe, and is the right
    // choice for a first run — nothing is lost but a second call.
    confirm_boxes: toBuy.length,
    suggested_limit: Math.min(toBuy.length, MAX_BOXES_PER_RUN),
    // How many capped calls this backlog would take. A plan larger than the cap is not
    // refused; it is bought in successive runs, each re-verified against TikTok.
    calls_needed_at_cap: Math.ceil(toBuy.length / MAX_BOXES_PER_RUN),
    batches: plan.batches.map((b) => ({ slip: b.slip, sku_number: b.sku_number, boxes: b.boxes.length })),
    page_sequence: planPageSequence(plan),
    excluded: run.excluded,
  });
}
