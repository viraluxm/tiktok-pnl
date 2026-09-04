// Resolve WHICH boxes a label run covers, shared by the dry run and the purchase job.
//
// WHY THIS IS SHARED CODE AND NOT COPIED. Create Packages buys the label outright — there is
// no quote and no cancel — so the pre-purchase dry run is the ONLY approval gate there can be.
// That gate is worthless if the purchase job resolves its candidates even slightly
// differently. Both routes therefore call this one function, and any divergence becomes
// impossible rather than merely unlikely.

import { getOrderById } from '@/lib/tiktok/client';
import { readAllPaged, readAllPagedIn } from '@/lib/db/readAll';
import { buildLabelPlan, type LabelPlan, type PlanBox, type PlanSkuLine } from '@/lib/shipping/labelPlan';
import {
  groupIntoBoxes, gateByAge, gateByVerifiedStatus, MIN_ORDER_AGE_HOURS, type GateBox,
} from '@/lib/shipping/candidateGate';

/** getOrderById accepts at most 50 ids per call. */
export const CHUNK = 50;
/** Verification calls per run — 1,000 candidates, a bounded and reviewable size. */
export const VERIFY_CALL_CAP = 20;
/** Heartbeat freshness that counts as "a show is running right now". */
export const LIVE_WINDOW_MIN = 20;
export { MIN_ORDER_AGE_HOURS };

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
  /**
   * When 'include', boxes with no SKU are planned alongside the rest (behind their own
   * header). Anything else leaves them out of the plan but still reports them, so the dry run
   * and the purchase agree about what they are looking at.
   */
  includeUnbound?: boolean;
}

export interface ResolvedLabelRun {
  candidateCount: number;
  candidateBoxCount: number;
  /** Boxes held back because their combine group may still be growing. */
  excludedTooRecent: number;
  excludedShowLive: number;
  verifiedCount: number;
  notVerifiedOverCap: number;
  confirmedCount: number;
  /** Status corrections TikTok implied. The caller decides whether to write them. */
  healed: Healed[];
  boxes: PlanBox[];
  /**
   * Boxes with no SKU on file. Returned SEPARATELY rather than dropped, because the caller has
   * to decide about them: unbound is usually a timing state (the team binds after a show), so
   * silently excluding these orders would leave them unshipped while everything around them
   * went out.
   */
  unboundBoxes: PlanBox[];
  plan: LabelPlan;
  excluded: Excluded[];
}

type Candidate = {
  order_id: string;
  auto_combine_group_id: string | null;
  order_created_at: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

/**
 * Everything up to (but excluding) the purchase: gather candidates, group them into boxes, gate
 * those boxes, verify against TikTok, and plan the print order.
 *
 * EVERY GATE OPERATES ON A WHOLE BOX. One label covers one box, so a box is either wholly safe
 * to buy or wholly held back. Half-boxes are the failure this shape prevents: labelling the
 * settled orders of a group that is still combining, or the surviving orders of a group whose
 * sibling has already shipped.
 *
 * Throws VerifyFailedError if TikTok could not be reached. That is deliberately fatal: the
 * cached status is exactly what this step exists to distrust.
 */
export async function resolveLabelRun(admin: Admin, opts: LabelRunOptions): Promise<ResolvedLabelRun> {
  const { userId, storeId, accessToken, shopCipher, tag, includeUnbound = false } = opts;
  const nowMs = Date.now();

  // ── 1. Candidates, from Lensed. Paged: PostgREST silently caps a response at 1000 rows. ──
  const rows = (await readAllPaged<Candidate>(
    (from, to) => admin.from('synced_order_ids')
      .select('order_id, auto_combine_group_id, order_created_at')
      .eq('user_id', userId).eq('store_id', storeId)
      .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null)
      .order('order_id', { ascending: true })
      .range(from, to),
    `labels ${tag} candidates`,
  )).map((c) => ({
    order_id: String(c.order_id),
    auto_combine_group_id: c.auto_combine_group_id ?? null,
    order_created_at: c.order_created_at ?? null,
  }));

  const excluded: Excluded[] = [];

  // ── 2. GROUP FIRST, then gate whole boxes. ──
  //
  // Grouping before verification is deliberate and does two things. It lets every gate operate
  // on the box, which is the unit that gets one label — gating per order would buy a label for
  // the settled half of a group still forming, the exact split shipment these gates exist to
  // prevent. And it means verification calls are only spent on boxes that survived the cheap
  // local checks.
  const allBoxes = groupIntoBoxes(rows);

  // ── 3. Age floor: has this box's combine group stopped growing? ──
  //
  // This replaces a live-session LOOKUP that had a hole: an order from the show running right
  // now has no auction-item row until it is captured, so the lookup could not see it. Measured
  // 2026-09-04 with five sessions heartbeating, 68 such orders slipped through. Age is a
  // property of the order itself and cannot be evaded by missing bookkeeping.
  const aged: GateBox[] = [];
  for (const b of allBoxes) {
    const v = gateByAge(b, nowMs);
    if (v.ok) { aged.push(b); continue; }
    excluded.push({ group_key: b.group_key, order_ids: b.orders.map((o) => o.order_id), reason: v.reason });
  }
  const excludedTooRecent = allBoxes.length - aged.length;

  // ── 4. Belt and braces: drop anything still tied to a running show. ──
  //
  // The age floor already covers this for any show of normal length. This stays for the
  // pathological case — a session running longer than the floor — and is gated on last_seen_at,
  // never live_sessions.status, which CLAUDE.md forbids as an interlock.
  const liveOrderIds = new Set<string>();
  if (aged.length) {
    const { data: liveSessions } = await admin
      .from('live_sessions').select('id')
      .eq('user_id', userId)
      .gte('last_seen_at', new Date(nowMs - LIVE_WINDOW_MIN * 60_000).toISOString());
    const liveIds = (liveSessions ?? []).map((s: { id: unknown }) => String(s.id));
    if (liveIds.length) {
      const liveItems = await readAllPagedIn<{ client_idempotency_key: string | null }, string>(
        liveIds,
        (chunk, from, to) => admin.from('live_auction_items')
          .select('client_idempotency_key')
          .eq('user_id', userId).in('session_id', chunk)
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

  const afterLive: GateBox[] = [];
  for (const b of aged) {
    const hit = b.orders.filter((o) => liveOrderIds.has(o.order_id));
    if (!hit.length) { afterLive.push(b); continue; }
    excluded.push({
      group_key: b.group_key, order_ids: b.orders.map((o) => o.order_id),
      reason: `show is live (${hit.length} of ${b.orders.length} orders in a running session)`,
    });
  }

  // ── 5. VERIFY with TikTok. The authoritative step. ──
  //
  // Measured 2026-09-03: of 100 orders Lensed believed were AWAITING_SHIPMENT, TikTok said 38
  // had already moved to AWAITING_COLLECTION — labels already bought. The drift is
  // one-directional (statuses advance and rarely reverse), so a stale cache always shows an
  // order as EARLIER in its lifecycle than it is. Every error is therefore a false positive
  // that this step catches; the only genuine miss is an order not yet synced, which the next
  // run picks up.
  //
  // The cap counts BOXES worth of orders, taken whole: splitting a box across the cap boundary
  // would leave it half-verified and unbuyable anyway.
  const toVerify: GateBox[] = [];
  let budget = VERIFY_CALL_CAP * CHUNK;
  for (const b of afterLive) {
    if (b.orders.length > budget) break;
    budget -= b.orders.length;
    toVerify.push(b);
  }
  const notVerifiedBoxes = afterLive.length - toVerify.length;
  const idsToVerify = toVerify.flatMap((b) => b.orders.map((o) => o.order_id));

  const liveStatus = new Map<string, string>();
  try {
    for (let i = 0; i < idsToVerify.length; i += CHUNK) {
      const ids = idsToVerify.slice(i, i + CHUNK);
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

  // ── 6. Every order in a box must still be awaiting shipment. Partial boxes are refused. ──
  const confirmedBoxes: GateBox[] = [];
  const healed: Healed[] = [];
  for (const b of toVerify) {
    const v = gateByVerifiedStatus(b, liveStatus);
    if (v.ok) { confirmedBoxes.push(b); continue; }
    excluded.push({ group_key: b.group_key, order_ids: b.orders.map((o) => o.order_id), reason: v.reason });
  }
  // Status corrections are collected for EVERY order TikTok disagreed about, including those in
  // boxes that were refused — the cache is wrong either way and healing it is free.
  for (const b of toVerify) {
    for (const o of b.orders) {
      const live = liveStatus.get(o.order_id);
      if (live && live !== 'AWAITING_SHIPMENT') {
        healed.push({ order_id: o.order_id, from: 'AWAITING_SHIPMENT', to: live });
      }
    }
  }

  // ── 7. Attach SKU lines. ──
  const confirmed = confirmedBoxes.flatMap((b) => b.orders.map((o) => ({ ...o, group_key: b.group_key })));
  const confirmedIds = confirmed.map((c) => c.order_id);
  const linesByOrder = new Map<string, PlanSkuLine[]>();
  if (confirmedIds.length) {
    // Chunked: an .in() list past ~750 ids blows undici's 16KB header cap and fails as an
    // opaque `TypeError: fetch failed`. A 400-box run averages 2.6 orders per box, so this
    // read routinely carries a thousand ids.
    const items = await readAllPagedIn<{ id: string; client_idempotency_key: string }, string>(
      confirmedIds,
      (chunk, from, to) => admin.from('live_auction_items')
        .select('id, client_idempotency_key')
        .eq('user_id', userId).in('client_idempotency_key', chunk)
        .order('id', { ascending: true }).range(from, to),
      `labels ${tag} auction items`,
    );
    const itemToOrder = new Map(items.map((i) => [String(i.id), String(i.client_idempotency_key)]));
    if (items.length) {
      // Same ceiling, and worse here: item ids are 36-character UUIDs, so this list hits 16KB
      // in roughly a third as many entries as the order-id read above.
      const skuRows = await readAllPagedIn<{
        auction_item_id: string; inventory_sku_id: string; qty: number;
        sku_number_snapshot: number | null; title_snapshot: string | null;
      }, string>(
        items.map((i) => String(i.id)),
        (chunk, from, to) => admin.from('live_auction_item_skus')
          .select('auction_item_id, inventory_sku_id, qty, sku_number_snapshot, title_snapshot')
          .eq('user_id', userId).in('auction_item_id', chunk)
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
  const unboundBoxes: PlanBox[] = [];
  for (const { group_key, orders } of confirmedBoxes) {
    const ids = orders.map((o) => o.order_id);
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
      // Kept, not dropped. The caller decides — see LabelRunOptions.includeUnbound.
      const box = { group_key, order_ids: ids, skus: [] as PlanSkuLine[] };
      unboundBoxes.push(box);
      if (includeUnbound) boxes.push(box);
      else excluded.push({ group_key, order_ids: ids, reason: 'no SKU on file — held back' });
      continue;
    }
    boxes.push({ group_key, order_ids: ids, skus: [...merged.values()] });
  }

  return {
    candidateCount: rows.length,
    candidateBoxCount: allBoxes.length,
    excludedTooRecent,
    excludedShowLive: aged.length - afterLive.length,
    verifiedCount: idsToVerify.length,
    notVerifiedOverCap: notVerifiedBoxes,
    confirmedCount: confirmed.length,
    healed,
    boxes,
    unboundBoxes,
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
