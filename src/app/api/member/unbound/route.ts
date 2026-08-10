import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { CAP_SELECT, filterUnboundChunk, type Cap, type UnboundRow } from '@/lib/member/unbound';

export const dynamic = 'force-dynamic';

// Opaque keyset cursor: the (ordered_at, order_id) of the last row of the previous page.
type Cursor = { o: string | null; i: string };
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (c && typeof c.i === 'string' && (c.o === null || typeof c.o === 'string')) return { o: c.o, i: c.i };
  } catch { /* bad cursor → start from the beginning */ }
  return null;
}

// Keyset .or() clause that resumes the (ordered_at asc nullsFirst, order_id asc) scan strictly
// AFTER the cursor row:
//   • cursor.o === null → still in the leading NULL-ordered_at group: (ordered_at null AND
//     order_id > i) OR any non-null ordered_at.
//   • cursor.o !== null → the null group is consumed: ordered_at > o, OR (ordered_at = o AND
//     order_id > i). Timestamps are double-quoted so ':'/'.'/'+' are literal in the filter string.
function keysetClause(cursor: Cursor): string {
  return cursor.o === null
    ? `and(ordered_at.is.null,order_id.gt.${cursor.i}),ordered_at.not.is.null`
    : `ordered_at.gt."${cursor.o}",and(ordered_at.eq."${cursor.o}",order_id.gt.${cursor.i})`;
}

// GET /api/member/unbound — cross-session binding queue, KEYSET-paginated.
//
// Keyset (not offset): pass ?cursor=<next_cursor from the previous page> to resume after its last
// row, so deep pages cost the same as the first (offset re-scanned from the start). ?limit default
// 50. Returns { unbound, next_cursor, has_more }. Filter logic is shared with the count route via
// @/lib/member/unbound (no duplication). Owner-scoped (service_role), requireMemberScope('binding').
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  // Optional single-store filter (the binding page's pill). Must be one of the member's assigned
  // stores (storeIds = their scope; all owner stores for an all-stores member) — else 403, so a
  // restricted member can't pass a store_id outside their scope. The client resets the keyset cursor
  // to page 1 when the filter changes; the cursor itself is filter-agnostic (order_id/ordered_at).
  const storeFilter = url.searchParams.get('store_id')?.trim() || null;
  if (storeFilter && !storeIds.includes(storeFilter)) {
    return NextResponse.json({ error: 'store_id not in scope' }, { status: 403 });
  }

  const CHUNK = 300;
  const collected: UnboundRow[] = [];
  const seen = new Set<string>();
  let scanCursor: Cursor | null = cursor; // where the capture scan resumes
  let exhausted = false;

  try {
    // Collect until we have limit+1 matched rows (to learn has_more) or run out of captures.
    while (collected.length <= limit && !exhausted) {
      // Filters (.in, .or) must precede transforms (.order, .limit) in the builder chain.
      let filter = admin.from('capture_events').select(CAP_SELECT).in('user_id', ownerIds);
      if (scanCursor) filter = filter.or(keysetClause(scanCursor));
      const { data: caps, error } = await filter
        .order('ordered_at', { ascending: true, nullsFirst: true })
        .order('order_id', { ascending: true })
        .limit(CHUNK);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const chunk = (caps ?? []) as Cap[];
      if (chunk.length < CHUNK) exhausted = true;
      if (!chunk.length) break;

      const rows = await filterUnboundChunk(admin, { ownerIds, allStores, storeIds, storeFilter }, chunk, seen);
      collected.push(...rows);

      // Advance the scan cursor to the LAST capture of the chunk (bound or not) so the next chunk
      // resumes after everything already examined.
      const last = chunk[chunk.length - 1];
      scanCursor = { o: (last.ordered_at as string | null) ?? null, i: String(last.order_id) };
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const page = collected.slice(0, limit);
  const has_more = collected.length > limit;
  const lastRow = page[page.length - 1];
  const next_cursor = has_more && lastRow ? encodeCursor({ o: lastRow.ordered_at, i: lastRow.order_id }) : null;

  // Strip the internal ordered_at (kept only for the cursor) from the response rows.
  const unbound = page.map(({ ordered_at: _ordered_at, ...r }) => r);

  return NextResponse.json({ unbound, limit, next_cursor, has_more });
}
