import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { createPackage, getPackageDocument, ALREADY_PURCHASED_CODES } from '@/lib/tiktok/client';
import { planPageSequence, type PlanBox } from '@/lib/shipping/labelPlan';
import {
  resolveLabelRun, shipTypeFor, VerifyFailedError, MIN_ORDER_AGE_HOURS,
} from '@/lib/shipping/labelRun';
import {
  authorizeRun, estimateSpend, parsePrice, MAX_BOXES_PER_RUN,
} from '@/lib/shipping/purchaseGuards';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST /api/shipping/labels/purchase?store_id=…&confirm_boxes=N&limit=M[&skip_docs=1]
//
// BUYS SHIPPING LABELS. This is the only route in the app that spends money.
//
// WHY IT IS SHAPED LIKE THIS. TikTok's Create Packages call is itself the purchase — verified
// on Snore 2026-09-03: one call moved an order AWAITING_SHIPMENT -> AWAITING_COLLECTION,
// issued tracking, and made the label downloadable, with no Ship Package call. The response
// carries a price, but reading it means the money is already spent. There is no quote, no
// two-phase commit and no cancel. Everything protective therefore happens BEFORE the first
// call:
//
//   1. FLAG. LABEL_PURCHASE_ENABLED must be '1'. Anything else returns the plan and buys
//      nothing, so the route can be deployed and exercised in production while inert.
//   2. VERIFY. Statuses are re-checked against TikTok, and a verification failure aborts
//      rather than falling back to Lensed's cache. 38% of one sample had already moved.
//   3. LEDGER. Boxes already recorded are removed before anything is counted or bought.
//   4. CONFIRM COUNT. The caller must pass the box count the dry run reported, and it must
//      match exactly. If a show ended or a sync landed in between, the count moves and this
//      refuses — so a plan nobody reviewed can never be bought.
//   5. LIMIT, REQUIRED. The most boxes this call may buy, with no default. confirm_boxes does
//      NOT protect against size — a caller that reads the dry run and passes its count back
//      through is perfectly consistent and would buy the whole backlog in one action, which is
//      exactly what a "Print labels" button would naturally do. Requiring `limit` means a
//      request cannot express "all of them": it has to name a ceiling, and that ceiling is
//      visible in the call.
//   6. CAP. `limit` may not exceed MAX_BOXES_PER_RUN, bounding the worst single call.
//
// DURING the run, two rules matter. Each box is CLAIMED in the ledger before its API call, so
// a crash cannot lead to a re-buy; and each box is wrapped individually, so one failure costs
// one label rather than aborting a run whose earlier purchases are already paid for.

/**
 * Stop buying with this much of the serverless budget left.
 *
 * A run that is cut off mid-flight is not dangerous — every purchase is already durable in the
 * ledger — but it is unobservable: the caller gets a 504 and no summary of what was bought.
 * Stopping early and reporting `remaining` keeps every run accounted for.
 */
const TIME_BUDGET_MS = 240_000;

export async function POST(req: Request) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const confirmRaw = url.searchParams.get('confirm_boxes');
  const limitRaw = url.searchParams.get('limit');
  const skipDocs = url.searchParams.get('skip_docs') === '1';
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });

  const confirmBoxes = confirmRaw == null || confirmRaw.trim() === '' ? null : Number(confirmRaw);
  if (confirmBoxes != null && !Number.isInteger(confirmBoxes)) {
    return NextResponse.json({ error: 'confirm_boxes must be an integer' }, { status: 400 });
  }
  // Absent stays NULL rather than defaulting. authorizeRun refuses a null limit, so an
  // omitted parameter can never be read as "no ceiling".
  const limit = limitRaw == null || limitRaw.trim() === '' ? null : Number(limitRaw);

  const admin = createAdminClient();

  const { data: conn } = await admin
    .from('tiktok_connections').select('*')
    .eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!conn) return NextResponse.json({ error: 'Store not connected' }, { status: 404 });

  const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });
  const token = fresh.accessToken as string;
  const cipher = (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string;

  // ── Resolve exactly what the dry run resolves. ──
  let run;
  try {
    run = await resolveLabelRun(admin, {
      userId: user.id, storeId, accessToken: token, shopCipher: cipher, tag: 'purchase',
    });
  } catch (e) {
    if (e instanceof VerifyFailedError) {
      return NextResponse.json(
        { error: `Could not verify order statuses with TikTok: ${e.message}`, verified: false, purchased: 0 },
        { status: 502 },
      );
    }
    throw e;
  }

  // ── Remove anything the ledger already owns. ──
  const { data: ledger } = await admin
    .from('shipping_label_purchases')
    .select('group_key, status')
    .eq('user_id', user.id).eq('store_id', storeId)
    .neq('status', 'failed')
    .in('group_key', run.boxes.map((b) => b.group_key));
  const alreadyOwned = new Set((ledger ?? []).map((r: { group_key: string }) => r.group_key));

  // Buy in the order the labels PRINT, so the ledger reads in the same sequence as the stack
  // and a partially-completed run leaves a contiguous, printable front section.
  const byKey = new Map(run.boxes.map((b) => [b.group_key, b]));
  const ordered: PlanBox[] = [];
  for (const page of planPageSequence(run.plan)) {
    if (page.kind !== 'label') continue;
    const b = byKey.get(page.group_key);
    if (b && !alreadyOwned.has(b.group_key)) ordered.push(b);
  }

  const decision = authorizeRun({
    enabled: process.env.LABEL_PURCHASE_ENABLED === '1',
    boxes: ordered.length,
    confirmBoxes,
    limit,
  });

  const planSummary = {
    store_id: storeId,
    verified_against_tiktok: true,
    boxes_in_plan: run.plan.totalBoxes,
    excluded_too_recent: run.excludedTooRecent,
    min_order_age_hours: MIN_ORDER_AGE_HOURS,
    already_in_ledger: alreadyOwned.size,
    would_buy: ordered.length,
    one_order_boxes: ordered.filter((b) => shipTypeFor(b) === '1').length,
    multi_order_boxes: ordered.filter((b) => shipTypeFor(b) === '3').length,
    max_boxes_per_run: MAX_BOXES_PER_RUN,
    limit_requested: limit,
    spend_estimate: await estimateSpend(admin, user.id, storeId, ordered.length),
  };

  if (!decision.ok) {
    // 'disabled' is the normal log-only state, not a client error: the route is deployed and
    // reachable, and reporting a 4xx for it would make a healthy deployment look broken.
    const status = decision.code === 'disabled' || decision.code === 'nothing_to_buy' ? 200 : 409;
    console.log(`[labels/purchase] refused (${decision.code}): ${decision.reason}`, planSummary);
    return NextResponse.json(
      { purchased: 0, spent: 0, authorized: false, code: decision.code, reason: decision.reason, ...planSummary },
      { status },
    );
  }

  // ── Buy, and ONLY as many as were authorised. ──
  //
  // decision.buy is min(limit, boxes) — the slice this call may spend on. Slicing here rather
  // than inside the loop keeps the bound in one place and makes it impossible for a later edit
  // to iterate the full plan by accident.
  const toBuy = ordered.slice(0, decision.buy);
  const runId = randomUUID();
  const bought: Array<{
    group_key: string; package_id: string; tracking_number: string | null;
    price: number | null; ship_type: string; already_existed?: true;
  }> = [];
  const failed: Array<{ group_key: string; code: number | null; message: string }> = [];
  const skipped: Array<{ group_key: string; reason: string }> = [];
  let stoppedEarly = false;

  for (const box of toBuy) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedEarly = true; break; }

    const shipType = shipTypeFor(box);

    // Each box is wrapped on its own. A throw here must not abandon a run whose earlier
    // purchases are already paid for and recorded.
    try {
      // ── CLAIM. Written BEFORE the call, so a crash cannot cause a re-buy. A unique-index
      // conflict means another run already owns this box: skip, never retry.
      const { error: claimError } = await admin
        .from('shipping_label_purchases')
        .insert({
          user_id: user.id, store_id: storeId, run_id: runId,
          group_key: box.group_key, order_ids: box.order_ids,
          status: 'claimed', ship_type: shipType,
        });
      if (claimError) {
        skipped.push({ group_key: box.group_key, reason: `claim rejected: ${claimError.message}` });
        continue;
      }

      const res = await createPackage(token, cipher, {
        shipType,
        orderId: shipType === '1' ? box.order_ids[0] : undefined,
        orderIds: shipType === '3' ? box.order_ids : undefined,
      });

      // TikTok's own idempotency guard fired: a label already exists for this box. That is a
      // completed box, NOT a failure — marking it failed would let a later run buy a second
      // label for one parcel.
      if (ALREADY_PURCHASED_CODES.has(res.code)) {
        await admin.from('shipping_label_purchases')
          .update({
            status: 'purchased', purchased_at: new Date().toISOString(),
            error_code: String(res.code),
            error_message: `already purchased at TikTok: ${res.message}`,
          })
          .eq('user_id', user.id).eq('store_id', storeId).eq('group_key', box.group_key);
        bought.push({
          group_key: box.group_key, package_id: '', tracking_number: null,
          price: null, ship_type: shipType, already_existed: true,
        });
        continue;
      }

      if (res.code !== 0 || !res.pkg?.package_id) {
        // No label was created, so the claim can be released for a later retry. The one case
        // deliberately NOT released is code -1 (unparseable response): we cannot tell whether
        // the call took effect, so the row stays 'claimed' and blocks re-purchase until a
        // human looks. Guessing "failed" there is how you buy a label twice.
        const releasable = res.code !== -1;
        await admin.from('shipping_label_purchases')
          .update({
            status: releasable ? 'failed' : 'claimed',
            error_code: String(res.code), error_message: res.message.slice(0, 500),
          })
          .eq('user_id', user.id).eq('store_id', storeId).eq('group_key', box.group_key);
        failed.push({ group_key: box.group_key, code: res.code, message: res.message.slice(0, 200) });
        continue;
      }

      // ── PURCHASED. Record the receipt before anything else can go wrong. ──
      const price = parsePrice(res.pkg.price);
      await admin.from('shipping_label_purchases')
        .update({
          status: 'purchased', purchased_at: new Date().toISOString(),
          package_id: res.pkg.package_id,
          price_amount: price, price_currency: res.pkg.currency ?? 'USD',
          shipping_provider_name: res.pkg.shipping_provider_name,
          shipping_service_name: res.pkg.shipping_service_name,
        })
        .eq('user_id', user.id).eq('store_id', storeId).eq('group_key', box.group_key);

      // ── The document. Best-effort ONLY. ──
      //
      // The label is already bought. A document failure must never mark the row 'failed' or a
      // retry would buy a second label; the doc can always be re-fetched from package_id.
      let tracking: string | null = null;
      if (!skipDocs) {
        try {
          const doc = await getPackageDocument(token, cipher, res.pkg.package_id);
          tracking = doc.tracking_number;
          await admin.from('shipping_label_purchases')
            .update({
              doc_url: doc.doc_url, tracking_number: doc.tracking_number,
              // ~24h on the one-box test. Stored so the assembly step knows when to re-fetch.
              doc_url_expires_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
            })
            .eq('user_id', user.id).eq('store_id', storeId).eq('group_key', box.group_key);
        } catch (e) {
          await admin.from('shipping_label_purchases')
            .update({ doc_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
            .eq('user_id', user.id).eq('store_id', storeId).eq('group_key', box.group_key);
        }
      }

      bought.push({
        group_key: box.group_key, package_id: res.pkg.package_id,
        tracking_number: tracking, price, ship_type: shipType,
      });
    } catch (e) {
      // The claim row stays 'claimed' on purpose: we do not know whether the purchase landed,
      // and 'claimed' is the state that refuses to buy again.
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ group_key: box.group_key, code: null, message: msg.slice(0, 200) });
      console.error(`[labels/purchase] box ${box.group_key} threw; left claimed`, msg);
    }
  }

  const spent = Math.round(bought.reduce((n, b) => n + (b.price ?? 0), 0) * 100) / 100;
  const result = {
    authorized: true,
    run_id: runId,
    store_id: storeId,
    purchased: bought.length,
    spent,
    currency: 'USD',
    failed: failed.length,
    skipped: skipped.length,
    // Boxes still unbought across the WHOLE plan, not just this slice — otherwise a limited
    // run would report 0 remaining and read as "the backlog is done".
    remaining: ordered.length - bought.length - failed.length - skipped.length,
    boxes_in_plan: ordered.length,
    limit_applied: decision.buy,
    limit_truncated_run: decision.buy < ordered.length,
    stopped_early: stoppedEarly,
    ...(stoppedEarly ? { stopped_reason: 'time budget — re-read the dry run and run again' } : {}),
    // Labels bought but whose document could not be fetched are still labels. They are listed
    // so they cannot be quietly lost; re-fetch from package_id.
    docs_skipped: skipDocs,
    bought,
    failed_detail: failed,
    skipped_detail: skipped,
  };
  console.log(`[labels/purchase] run ${runId}: bought ${bought.length}, spent $${spent}, failed ${failed.length}`);
  return NextResponse.json(result);
}
