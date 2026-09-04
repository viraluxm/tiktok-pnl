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
  const rows = await readAllPaged<CandidateRow>(
    (from, to) => {
      let q = admin.from('synced_order_ids')
        .select('order_id, auto_combine_group_id, order_created_at')
        .eq('user_id', userId).eq('store_id', storeId)
        .eq('status', 'AWAITING_SHIPMENT').is('tracking_number', null);
      if (scope.kind === 'day') {
        const { fromISO, toISO } = dayWindow(scope.day);
        q = q.gte('order_created_at', fromISO).lt('order_created_at', toISO);
      }
      return q.order('order_id', { ascending: true }).range(from, to);
    },
    `labels ${tag} candidates`,
  );

  const mapped = rows.map((c) => ({
    order_id: String(c.order_id),
    auto_combine_group_id: c.auto_combine_group_id ?? null,
    order_created_at: c.order_created_at ?? null,
  }));

  if (scope.kind !== 'lives') return mapped;

  const inScope = await orderIdsForSessions(admin, userId, scope.sessionIds, tag);
  return mapped.filter((c) => inScope.has(c.order_id));
}
