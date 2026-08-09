import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// GET /api/member/unbound — the cross-session binding queue for a member.
//
// "Unbound" = a capture_events row whose order_id has NO matching live_auction_items
// (client_idempotency_key = order_id) for the owners. Field mapping + the status/payment filters
// mirror the per-session unbound synthesis in
//   src/app/api/live/sessions/[id]/board/route.ts:239-281
// EXACTLY:
//   • order_id must be non-empty and !== '0'
//   • is_payment_successful !== false   (drop failed payments)
//   • CANCELLED dropped via synced_order_ids.status
//   • store_id taken from synced_order_ids (reliable) — capture_events.store_id is often NULL
// Cross-session vs board's single-session scope: an order is unbound only if it is bound in NO
// session (board excludes just that session's bound set).
//
// PAGINATION (no cap, no in-memory anti-join over the whole table): stream capture_events
// oldest-first in bounded chunks; for each chunk resolve bound status with a single IN query
// against live_auction_items, and CANCELLED/store via one IN against synced_order_ids. Accumulate
// matched (unbound) rows only until the requested page (offset+limit, plus one to learn has_more)
// is filled, then stop. Correct pagination over ~43k captures without scanning them all per page.
//
// Owner-scoped (service_role), gated on requireMemberScope('binding'). Read-only.
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const wanted = offset + limit; // matched rows needed to fill the page; +1 more tells us has_more

  const storeSet = new Set(storeIds);
  const CHUNK = 300; // capture rows per scan; also the .in() batch size (single IN per chunk)

  type Cap = {
    order_id: string; selling_price_cents: number | null; product_name: string | null;
    platform_sku_ref: string | null; buyer_username: string | null; is_payment_successful: boolean | null;
    ordered_at: string | null; created_at: string | null; store_id: string | null;
  };
  type Row = {
    order_id: string; tiktok_title: string | null; seller_sku_hint: string | null;
    won_price_cents: number | null; buyer_handle: string | null; logged_at: string; store_id: string | null;
  };

  const matched: Row[] = [];
  const seen = new Set<string>();
  let exhausted = false;

  for (let from = 0; matched.length <= wanted && !exhausted; from += CHUNK) {
    // Deterministic oldest-first order: (ordered_at, order_id) so .range() paging is stable.
    const { data: caps, error: capErr } = await admin
      .from('capture_events')
      .select('order_id, selling_price_cents, product_name, platform_sku_ref, buyer_username, is_payment_successful, ordered_at, created_at, store_id')
      .in('user_id', ownerIds)
      .order('ordered_at', { ascending: true, nullsFirst: true })
      .order('order_id', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (capErr) return NextResponse.json({ error: capErr.message }, { status: 500 });
    const chunk = (caps ?? []) as Cap[];
    if (chunk.length < CHUNK) exhausted = true;
    if (!chunk.length) break;

    // Candidate order_ids in this chunk (cheap filters first): valid, not '0'.
    const chunkOids = [...new Set(chunk.map((c) => String(c.order_id ?? '')).filter((oid) => oid && oid !== '0'))];
    if (!chunkOids.length) continue;

    // Bound status for exactly this chunk (one IN query) — the anti-join, chunked.
    const bound = new Set<string>();
    {
      const { data: b, error: bErr } = await admin
        .from('live_auction_items')
        .select('client_idempotency_key')
        .in('user_id', ownerIds)
        .in('client_idempotency_key', chunkOids);
      if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });
      for (const r of b ?? []) { const k = r.client_idempotency_key; if (k) bound.add(String(k)); }
    }

    // CANCELLED + reliable store_id for this chunk (one IN query).
    const cancelled = new Set<string>();
    const syncedStore = new Map<string, string | null>();
    {
      const { data: so, error: sErr } = await admin
        .from('synced_order_ids')
        .select('order_id, status, store_id')
        .in('user_id', ownerIds)
        .in('order_id', chunkOids);
      if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
      for (const r of so ?? []) {
        const oid = String(r.order_id);
        if (String(r.status) === 'CANCELLED') cancelled.add(oid);
        syncedStore.set(oid, (r.store_id as string | null) ?? null);
      }
    }

    for (const c of chunk) {
      if (matched.length > wanted) break; // enough to fill the page and know has_more
      const oid = String(c.order_id ?? '');
      if (!oid || oid === '0' || seen.has(oid)) continue;
      if (c.is_payment_successful === false) continue; // board: keep unless explicitly false
      if (bound.has(oid)) continue;                    // bound in some session → not in the queue
      if (cancelled.has(oid)) continue;                // authoritative CANCELLED
      if (!allStores) {
        // Store-restricted member: require a synced row confirming one of their stores.
        const st = syncedStore.get(oid);
        if (!st || !storeSet.has(st)) continue;
      }
      seen.add(oid);
      matched.push({
        order_id: oid,
        tiktok_title: (c.product_name as string | null) ?? null,
        seller_sku_hint: (c.platform_sku_ref as string | null) ?? null, // lot #
        won_price_cents: (c.selling_price_cents as number | null) ?? null,
        buyer_handle: (c.buyer_username as string | null) ?? null,
        logged_at: (c.ordered_at as string | null) ?? (c.created_at as string | null) ?? '',
        store_id: syncedStore.get(oid) ?? (c.store_id as string | null) ?? null, // synced (reliable) first
      });
    }
  }

  // NOTE: session_id is deliberately NOT returned. A capture only carries room_id
  // (= live_sessions.tiktok_live_id); a room hosts many sessions over time and open-ended
  // sessions (ended_at NULL) overlap every later timestamp, so a timestamp routinely matches more
  // than one session and any pick would be a guess. The bind write will key on session, so a wrong
  // guess would mis-attribute revenue/host metrics — better to omit it than to guess.

  const page = matched.slice(offset, offset + limit);
  return NextResponse.json({
    unbound: page,
    limit,
    offset,
    has_more: matched.length > offset + limit,
  });
}
