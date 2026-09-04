import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { readAllPaged } from '@/lib/db/readAll';
import { buildLabelPlan, planPageSequence, type PlanBox, type PlanSkuLine } from '@/lib/shipping/labelPlan';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// GET /api/shipping/labels/dry-run?store_id=…[&heal=1]
//
// What a label run WOULD buy, and the order it would print. Buys nothing. This output is the
// approval gate: nothing is purchased until a human has read it.
//
// IT VERIFIES AGAINST TIKTOK RATHER THAN TRUSTING LENSED. Measured 2026-09-03: of 100 orders
// Lensed believed were AWAITING_SHIPMENT, TikTok said 38 had already moved to
// AWAITING_COLLECTION — labels already bought. Buying on the cached status would have
// purchased ~60 duplicate labels on the Snore test set alone.
//
// The drift is one-directional and that is why this works. Statuses advance
// (AWAITING_SHIPMENT → AWAITING_COLLECTION → IN_TRANSIT → DELIVERED) and rarely reverse, so a
// stale cache shows orders as EARLIER in the lifecycle than they are — always a false positive,
// never a false negative. Verifying the candidates therefore catches every case that matters;
// the only genuine miss is an order Lensed has not synced yet, which the next run picks up.
//
// `heal=1` writes corrected statuses back for the orders it checked — the same write the sync
// cron makes, on precisely the orders we care about, in two calls instead of a 240s sweep.
// OFF by default: a thing called "dry run" should not write.

const CHUNK = 50;                    // getOrderById max ids/call
const VERIFY_CALL_CAP = 20;          // 1,000 candidates/run — a bounded, reviewable run
const LIVE_WINDOW_MIN = 20;          // heartbeat freshness that counts as "show running"

type Excluded = { group_key: string; order_ids: string[]; reason: string };

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

  // ── 1. Candidates, from Lensed. Paged: a response is capped at 1000 rows silently. ──
  const candidates = await readAllPaged(
    (from, to) => admin.from('synced_order_ids')
      .select('order_id, auto_combine_group_id')
      .eq('user_id', user.id).eq('store_id', storeId)
      .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null)
      .order('order_id', { ascending: true })
      .range(from, to),
    'label dry-run candidates',
  );

  const excluded: Excluded[] = [];
  const keyOf = (o: { order_id: string; auto_combine_group_id: string | null }) =>
    o.auto_combine_group_id ?? `order:${o.order_id}`;

  // ── 2. Drop anything from a show that is running. ──
  //
  // Gated on last_seen_at, never live_sessions.status — CLAUDE.md forbids that flag as an
  // interlock. Buying a running show's labels mid-show is the expensive mistake here.
  const orderIds = candidates.map((c) => String(c.order_id));
  const liveOrderIds = new Set<string>();
  if (orderIds.length) {
    const { data: liveSessions } = await admin
      .from('live_sessions').select('id')
      .eq('user_id', user.id)
      .gte('last_seen_at', new Date(Date.now() - LIVE_WINDOW_MIN * 60_000).toISOString());
    const liveIds = (liveSessions ?? []).map((s) => String(s.id));
    if (liveIds.length) {
      const liveItems = await readAllPaged(
        (from, to) => admin.from('live_auction_items')
          .select('client_idempotency_key')
          .eq('user_id', user.id).in('session_id', liveIds)
          .order('id', { ascending: true })
          .range(from, to),
        'label dry-run live-session items',
      );
      for (const i of liveItems) {
        const k = String(i.client_idempotency_key ?? '');
        if (k) liveOrderIds.add(k);
      }
    }
  }

  const afterLive = candidates.filter((c) => !liveOrderIds.has(String(c.order_id)));
  for (const c of candidates) {
    if (liveOrderIds.has(String(c.order_id))) {
      excluded.push({ group_key: keyOf(c), order_ids: [String(c.order_id)], reason: 'show is live' });
    }
  }

  // ── 3. VERIFY with TikTok. The authoritative step. ──
  const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });
  const token = fresh.accessToken as string;
  const cipher = (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string;

  const toVerify = afterLive.slice(0, VERIFY_CALL_CAP * CHUNK);
  const notVerified = afterLive.length - toVerify.length;
  const liveStatus = new Map<string, string>();
  let verifyError: string | null = null;
  try {
    for (let i = 0; i < toVerify.length; i += CHUNK) {
      const ids = toVerify.slice(i, i + CHUNK).map((c) => String(c.order_id));
      for (const o of await getOrderById(token, cipher, ids)) {
        liveStatus.set(String((o as { id: unknown }).id), String((o as { status: unknown }).status || '').toUpperCase());
      }
    }
  } catch (e) {
    verifyError = e instanceof Error ? e.message : String(e);
  }
  // A failed verification must NOT fall back to the cached status — that is precisely the
  // mistake this step exists to prevent. Report and plan nothing.
  if (verifyError) {
    return NextResponse.json(
      { error: `Could not verify order statuses with TikTok: ${verifyError}`, verified: false },
      { status: 502 },
    );
  }

  const confirmed: typeof afterLive = [];
  const healed: Array<{ order_id: string; from: string; to: string }> = [];
  for (const c of toVerify) {
    const id = String(c.order_id);
    const live = liveStatus.get(id);
    if (live === 'AWAITING_SHIPMENT') { confirmed.push(c); continue; }
    excluded.push({
      group_key: keyOf(c), order_ids: [id],
      reason: live ? `TikTok says ${live}` : 'TikTok returned no such order',
    });
    if (live) healed.push({ order_id: id, from: 'AWAITING_SHIPMENT', to: live });
  }

  if (heal && healed.length) {
    for (const h of healed) {
      await admin.from('synced_order_ids').update({ status: h.to })
        .eq('user_id', user.id).eq('store_id', storeId)
        .eq('order_id', h.order_id).neq('status', h.to);
    }
  }

  // ── 4. Collapse to boxes, attach SKU lines. ──
  const byBox = new Map<string, string[]>();
  for (const c of confirmed) {
    const k = keyOf(c);
    const arr = byBox.get(k);
    if (arr) arr.push(String(c.order_id));
    else byBox.set(k, [String(c.order_id)]);
  }

  const confirmedIds = confirmed.map((c) => String(c.order_id));
  const linesByOrder = new Map<string, PlanSkuLine[]>();
  if (confirmedIds.length) {
    const items = await readAllPaged(
      (from, to) => admin.from('live_auction_items')
        .select('id, client_idempotency_key')
        .eq('user_id', user.id).in('client_idempotency_key', confirmedIds)
        .order('id', { ascending: true }).range(from, to),
      'label dry-run auction items',
    );
    const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
    if (items.length) {
      const skuRows = await readAllPaged(
        (from, to) => admin.from('live_auction_item_skus')
          .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
          .eq('user_id', user.id).in('auction_item_id', items.map((i) => String(i.id)))
          .order('auction_item_id', { ascending: true }).range(from, to),
        'label dry-run sku lines',
      );
      for (const r of skuRows) {
        const oid = itemToOrder.get(String(r.auction_item_id));
        if (!oid) continue;
        const arr = linesByOrder.get(oid) ?? [];
        arr.push({
          inventory_sku_id: String(r.inventory_sku_id),
          sku_number: (r.sku_number_snapshot as number | null) ?? null,
          title: String(r.title_snapshot ?? ''),
          qty: Number(r.qty) || 0,
        });
        linesByOrder.set(oid, arr);
      }
    }
  }

  const boxes: PlanBox[] = [];
  for (const [group_key, ids] of byBox) {
    // Merge the box's SKU lines, summing quantities per SKU so a combine group holding two
    // orders of the same SKU reads as one line of two units — which correctly makes it a
    // bundle rather than a batchable single.
    const merged = new Map<string, PlanSkuLine>();
    for (const oid of ids) {
      for (const l of linesByOrder.get(oid) ?? []) {
        const e = merged.get(l.inventory_sku_id);
        if (e) e.qty += l.qty;
        else merged.set(l.inventory_sku_id, { ...l });
      }
    }
    if (merged.size === 0) {
      excluded.push({ group_key, order_ids: ids, reason: 'no SKUs bound — cannot classify' });
      continue;
    }
    boxes.push({ group_key, order_ids: ids, skus: [...merged.values()] });
  }

  const plan = buildLabelPlan(boxes);

  return NextResponse.json({
    dry_run: true,
    purchased: 0,
    store_id: storeId,
    verified_against_tiktok: true,
    healed: heal ? healed.length : 0,
    heal_available: !heal && healed.length > 0 ? healed.length : 0,
    counts: {
      candidates_in_lensed: candidates.length,
      excluded_show_live: candidates.length - afterLive.length,
      verified: toVerify.length,
      not_verified_over_cap: notVerified,
      confirmed_label_ready: confirmed.length,
      boxes: plan.totalBoxes,
      orders: plan.totalOrders,
      batched_boxes: plan.batchedBoxes,
      bundle_boxes: plan.bundles.length,
      sku_batches: plan.batches.length,
      // Distinguishes "nothing could batch" from "these could have, but each was alone".
      demoted_singletons: plan.demotedSingletons,
      demoted_skus: plan.demotedSkus,
    },
    batches: plan.batches.map((b) => ({ slip: b.slip, sku_number: b.sku_number, boxes: b.boxes.length })),
    page_sequence: planPageSequence(plan),
    excluded,
  });
}
