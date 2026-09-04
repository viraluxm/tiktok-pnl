// Resolve WHICH boxes a label run covers, shared by the dry run and the purchase job.
//
// WHY THIS IS SHARED CODE AND NOT COPIED. Create Packages buys the label outright — there is
// no quote and no cancel — so the pre-purchase dry run is the ONLY approval gate there can be.
// That gate is worthless if the purchase job resolves its candidates even slightly
// differently. Both routes therefore call this one function, and any divergence becomes
// impossible rather than merely unlikely.

import { getOrderById } from '@/lib/tiktok/client';
import { readAllPaged } from '@/lib/db/readAll';
import { buildLabelPlan, type LabelPlan, type PlanBox, type PlanSkuLine } from '@/lib/shipping/labelPlan';

/** getOrderById accepts at most 50 ids per call. */
export const CHUNK = 50;
/** Verification calls per run — 1,000 candidates, a bounded and reviewable size. */
export const VERIFY_CALL_CAP = 20;
/** Heartbeat freshness that counts as "a show is running right now". */
export const LIVE_WINDOW_MIN = 20;

export type Excluded = { group_key: string; order_ids: string[]; reason: string };
export type Healed = { order_id: string; from: string; to: string };

/** A box's ship_type, per Create Packages: one order in one package, or several in one. */
export function shipTypeFor(box: PlanBox): '1' | '3' {
  return box.order_ids.length === 1 ? '1' : '3';
}

/** Verification could not be completed. Callers must plan NOTHING — never fall back to cache. */
export class VerifyFailedError extends Error {}

export interface LabelRunOptions {
  userId: string;
  storeId: string;
  accessToken: string;
  shopCipher: string;
  /** Short tag used in read labels and logs, e.g. 'dry-run' or 'purchase'. */
  tag: string;
}

export interface ResolvedLabelRun {
  candidateCount: number;
  excludedShowLive: number;
  verifiedCount: number;
  notVerifiedOverCap: number;
  confirmedCount: number;
  /** Status corrections TikTok implied. The caller decides whether to write them. */
  healed: Healed[];
  boxes: PlanBox[];
  plan: LabelPlan;
  excluded: Excluded[];
}

type Candidate = { order_id: string; auto_combine_group_id: string | null };

const keyOf = (o: Candidate) => o.auto_combine_group_id ?? `order:${o.order_id}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

/**
 * Everything up to (but excluding) the purchase: gather candidates, drop running shows, verify
 * against TikTok, collapse to boxes, and plan the print order.
 *
 * Throws VerifyFailedError if TikTok could not be reached. That is deliberately fatal: the
 * cached status is exactly what this step exists to distrust.
 */
export async function resolveLabelRun(admin: Admin, opts: LabelRunOptions): Promise<ResolvedLabelRun> {
  const { userId, storeId, accessToken, shopCipher, tag } = opts;

  // ── 1. Candidates, from Lensed. Paged: PostgREST silently caps a response at 1000 rows. ──
  const candidates = (await readAllPaged<Candidate>(
    (from, to) => admin.from('synced_order_ids')
      .select('order_id, auto_combine_group_id')
      .eq('user_id', userId).eq('store_id', storeId)
      .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null)
      .order('order_id', { ascending: true })
      .range(from, to),
    `labels ${tag} candidates`,
  )).map((c) => ({ order_id: String(c.order_id), auto_combine_group_id: c.auto_combine_group_id ?? null }));

  const excluded: Excluded[] = [];

  // ── 2. Drop anything from a show that is running. ──
  //
  // Gated on last_seen_at, never live_sessions.status — CLAUDE.md forbids that flag as an
  // interlock. Buying a running show's labels mid-show is the expensive mistake here, because
  // its orders are still being combined and a label bought now covers the wrong box.
  const liveOrderIds = new Set<string>();
  if (candidates.length) {
    const { data: liveSessions } = await admin
      .from('live_sessions').select('id')
      .eq('user_id', userId)
      .gte('last_seen_at', new Date(Date.now() - LIVE_WINDOW_MIN * 60_000).toISOString());
    const liveIds = (liveSessions ?? []).map((s: { id: unknown }) => String(s.id));
    if (liveIds.length) {
      const liveItems = await readAllPaged<{ client_idempotency_key: string | null }>(
        (from, to) => admin.from('live_auction_items')
          .select('client_idempotency_key')
          .eq('user_id', userId).in('session_id', liveIds)
          .order('id', { ascending: true })
          .range(from, to),
        `labels ${tag} live-session items`,
      );
      for (const i of liveItems) {
        const k = String(i.client_idempotency_key ?? '');
        if (k) liveOrderIds.add(k);
      }
    }
  }

  const afterLive = candidates.filter((c) => !liveOrderIds.has(c.order_id));
  for (const c of candidates) {
    if (liveOrderIds.has(c.order_id)) {
      excluded.push({ group_key: keyOf(c), order_ids: [c.order_id], reason: 'show is live' });
    }
  }

  // ── 3. VERIFY with TikTok. The authoritative step. ──
  //
  // Measured 2026-09-03: of 100 orders Lensed believed were AWAITING_SHIPMENT, TikTok said 38
  // had already moved to AWAITING_COLLECTION — labels already bought. The drift is
  // one-directional (statuses advance and rarely reverse), so a stale cache always shows an
  // order as EARLIER in its lifecycle than it is. Every error is therefore a false positive
  // that this step catches; the only genuine miss is an order not yet synced, which the next
  // run picks up.
  const toVerify = afterLive.slice(0, VERIFY_CALL_CAP * CHUNK);
  const liveStatus = new Map<string, string>();
  try {
    for (let i = 0; i < toVerify.length; i += CHUNK) {
      const ids = toVerify.slice(i, i + CHUNK).map((c) => c.order_id);
      for (const o of await getOrderById(accessToken, shopCipher, ids)) {
        liveStatus.set(
          String((o as { id: unknown }).id),
          String((o as { status: unknown }).status || '').toUpperCase(),
        );
      }
    }
  } catch (e) {
    throw new VerifyFailedError(e instanceof Error ? e.message : String(e));
  }

  const confirmed: Candidate[] = [];
  const healed: Healed[] = [];
  for (const c of toVerify) {
    const live = liveStatus.get(c.order_id);
    if (live === 'AWAITING_SHIPMENT') { confirmed.push(c); continue; }
    excluded.push({
      group_key: keyOf(c), order_ids: [c.order_id],
      reason: live ? `TikTok says ${live}` : 'TikTok returned no such order',
    });
    if (live) healed.push({ order_id: c.order_id, from: 'AWAITING_SHIPMENT', to: live });
  }

  // ── 4. Collapse to boxes, attach SKU lines. ──
  const byBox = new Map<string, string[]>();
  for (const c of confirmed) {
    const k = keyOf(c);
    const arr = byBox.get(k);
    if (arr) arr.push(c.order_id);
    else byBox.set(k, [c.order_id]);
  }

  const confirmedIds = confirmed.map((c) => c.order_id);
  const linesByOrder = new Map<string, PlanSkuLine[]>();
  if (confirmedIds.length) {
    const items = await readAllPaged<{ id: string; client_idempotency_key: string }>(
      (from, to) => admin.from('live_auction_items')
        .select('id, client_idempotency_key')
        .eq('user_id', userId).in('client_idempotency_key', confirmedIds)
        .order('id', { ascending: true }).range(from, to),
      `labels ${tag} auction items`,
    );
    const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
    if (items.length) {
      const skuRows = await readAllPaged<{
        auction_item_id: string; inventory_sku_id: string; qty: number;
        sku_number_snapshot: number | null; title_snapshot: string | null;
      }>(
        (from, to) => admin.from('live_auction_item_skus')
          .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
          .eq('user_id', userId).in('auction_item_id', items.map((i) => String(i.id)))
          .order('auction_item_id', { ascending: true }).range(from, to),
        `labels ${tag} sku lines`,
      );
      for (const r of skuRows) {
        const oid = itemToOrder.get(String(r.auction_item_id));
        if (!oid) continue;
        const arr = linesByOrder.get(oid) ?? [];
        arr.push({
          inventory_sku_id: String(r.inventory_sku_id),
          sku_number: r.sku_number_snapshot ?? null,
          title: String(r.title_snapshot ?? ''),
          qty: Number(r.qty) || 0,
        });
        linesByOrder.set(oid, arr);
      }
    }
  }

  const boxes: PlanBox[] = [];
  for (const [group_key, ids] of byBox) {
    // Merge the box's SKU lines, summing quantities per SKU, so a combine group holding two
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

  return {
    candidateCount: candidates.length,
    excludedShowLive: candidates.length - afterLive.length,
    verifiedCount: toVerify.length,
    notVerifiedOverCap: afterLive.length - toVerify.length,
    confirmedCount: confirmed.length,
    healed,
    boxes,
    plan: buildLabelPlan(boxes),
    excluded,
  };
}

/** Write back the status corrections TikTok implied. Same write the sync cron makes. */
export async function applyHealed(
  admin: Admin, userId: string, storeId: string, healed: Healed[],
): Promise<void> {
  for (const h of healed) {
    await admin.from('synced_order_ids').update({ status: h.to })
      .eq('user_id', userId).eq('store_id', storeId)
      .eq('order_id', h.order_id).neq('status', h.to);
  }
}
