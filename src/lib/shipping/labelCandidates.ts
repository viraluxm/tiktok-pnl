// Read a store's label candidates, optionally narrowed to a fulfilment day or a set of lives.
//
// Split out of labelRun so the scope PICKER and the label RUN read candidates the same way. The
// picker's counts are a promise about what a run will find; if the two queries drifted, the
// dropdown would advertise boxes the run then declines to buy.

import { readAllPaged, readAllPagedIn } from '@/lib/db/readAll';
import { dayWindow, type LabelScope } from '@/lib/shipping/labelScope';

/** A candidate order as every downstream gate sees it. */
export interface CandidateRow {
  order_id: string;
  auto_combine_group_id: string | null;
  order_created_at: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

/**
 * Order ids belonging to the given live sessions.
 *
 * Chunked on BOTH sides: the session id list goes through `.in()` (bounded by MAX_SCOPE_LIVES)
 * and the result can be tens of thousands of rows, so it pages too.
 */
export async function orderIdsForSessions(
  admin: Admin, userId: string, sessionIds: string[], tag: string,
): Promise<Set<string>> {
  const rows = await readAllPagedIn<{ client_idempotency_key: string | null }, string>(
    sessionIds,
    (chunk, from, to) => admin.from('live_auction_items')
      .select('client_idempotency_key')
      .eq('user_id', userId).in('session_id', chunk)
      .order('id', { ascending: true }).range(from, to),
    `labels ${tag} scope sessions`,
  );
  const out = new Set<string>();
  for (const r of rows) {
    const k = String(r.client_idempotency_key ?? '');
    if (k) out.add(k);
  }
  return out;
}

/**
 * Every order eligible for a label, narrowed by scope.
 *
 * DAY is filtered in the QUERY, on order_created_at against the 04:00→04:00 window — cheap, and
 * it keeps the row count down before anything else runs. LIVES is filtered in memory against the
 * session's order ids, because the link lives in live_auction_items and a join is not available
 * through PostgREST here.
 *
 * Scope only ever REMOVES rows. Every safety gate still runs on whatever survives, so selecting
 * a live that is still running yields nothing rather than buying mid-show.
 */
export async function readCandidates(
  admin: Admin, userId: string, storeId: string, scope: LabelScope, tag: string,
): Promise<CandidateRow[]> {
  const base = (from: number, to: number) => admin.from('synced_order_ids')
    .select('order_id, auto_combine_group_id, order_created_at')
    .eq('user_id', userId).eq('store_id', storeId)
    .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null)
    .order('order_id', { ascending: true })
    .range(from, to);

  const norm = (c: CandidateRow) => ({
    order_id: String(c.order_id),
    auto_combine_group_id: c.auto_combine_group_id ?? null,
    order_created_at: c.order_created_at ?? null,
  });

  if (scope.kind === 'all') {
    return (await readAllPaged<CandidateRow>(base, `labels ${tag} candidates`)).map(norm);
  }

  // ── Which GROUPS the scope selects. ──
  //
  // A scope picks BOXES, never loose orders, and the two are not the same thing: 64 of Sep 3's
  // 534 boxes straddle the 04:00 boundary, and filtering orders by date cut 183 of their orders
  // away — one group lost 19 of its 20. A label bought for what was left would have covered a
  // fraction of the parcel and orphaned the rest, which is precisely the partial box the
  // verification gate refuses. It could not catch this one, because the missing orders were
  // removed BEFORE grouping, so the gate never knew they existed.
  //
  // So selection happens on groups, and the group is then re-read WHOLE.
  let seedRows: CandidateRow[];
  if (scope.kind === 'day') {
    // Days are read one window at a time rather than as a single min→max span: two chosen days
    // need not be adjacent, and a span would silently sweep in the days between them.
    const byId = new Map<string, CandidateRow>();
    for (const d of scope.days) {
      const { fromISO, toISO } = dayWindow(d);
      const rows = await readAllPaged<CandidateRow>(
        (from, to) => base(from, to).gte('order_created_at', fromISO).lt('order_created_at', toISO),
        `labels ${tag} day seed ${d}`,
      );
      for (const r of rows) byId.set(String(r.order_id), r);
    }
    seedRows = [...byId.values()];
  } else {
    const inScope = await orderIdsForSessions(admin, userId, scope.sessionIds, tag);
    seedRows = (await readAllPaged<CandidateRow>(base, `labels ${tag} candidates`))
      .filter((c) => inScope.has(String(c.order_id)));
  }

  const groupIds = [...new Set(
    seedRows.map((r) => r.auto_combine_group_id).filter((g): g is string => !!g),
  )];
  // Orders with no group id are their own box: nothing to expand, keep them as they are.
  const loose = seedRows.filter((r) => !r.auto_combine_group_id).map(norm);

  if (!groupIds.length) return loose;

  // Re-read every order of every selected group, with NO date or session filter, so each box is
  // whole. A box straddling two days is therefore reachable from either — correct, and the age
  // gate still holds it back until its YOUNGEST order has settled.
  const whole = await readAllPagedIn<CandidateRow, string>(
    groupIds,
    (chunk, from, to) => admin.from('synced_order_ids')
      .select('order_id, auto_combine_group_id, order_created_at')
      .eq('user_id', userId).eq('store_id', storeId)
      .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null)
      .in('auto_combine_group_id', chunk)
      .order('order_id', { ascending: true }).range(from, to),
    `labels ${tag} whole groups`,
  );

  const seen = new Set(loose.map((r) => r.order_id));
  const out = [...loose];
  for (const r of whole.map(norm)) {
    if (seen.has(r.order_id)) continue;
    seen.add(r.order_id);
    out.push(r);
  }
  return out;
}
