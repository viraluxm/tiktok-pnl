import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { CAP_SELECT, filterUnboundChunk, type Cap, type UnboundRow } from '@/lib/member/unbound';
import { encodeCursor, decodeCursor, keysetClause, orderBy, sortToDesc, type Cursor } from '@/lib/member/unboundKeyset';

export const dynamic = 'force-dynamic';

const TZ = 'America/Los_Angeles';

// PT start-of-day (midnight) N days ago as an offset-bearing ISO instant. The offset is derived
// from Intl for THAT date (DST-correct: PDT vs PST) — never a hardcoded UTC offset.
function ptDayStartISO(daysAgo: number): string {
  const now = new Date();
  const dfDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD in PT
  const [y, m, d] = dfDate.format(now).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12) - daysAgo * 86400000); // safe midday of target PT day
  const targetPT = dfDate.format(probe);
  const offPart = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const offset = offPart.replace('GMT', '') || '+00:00'; // e.g. "-07:00"
  return `${targetPT}T00:00:00.000${offset}`;
}

// date pill → lower bound only. Direction used to be decided here (today/7d/30d newest-first,
// 'all' oldest-first), which made the sort an invisible side effect of the date filter. It is now
// an independent ?sort param, so the two are separate concerns and all four combinations are
// reachable. Each combination still seeds the scan AT one end of its own range — a bounded
// newest-first scan starts at the newest, an unbounded oldest-first scan starts at the oldest —
// so decoupling them costs nothing.
function dateLowerBound(date: string): string | null {
  switch (date) {
    case 'today': return ptDayStartISO(0);
    case '30d': return ptDayStartISO(29);
    case 'all': return null;
    case '7d':
    default: return ptDayStartISO(6);
  }
}

// GET /api/member/unbound — cross-session binding queue, KEYSET-paginated. Owner-scoped
// (service_role), requireMemberScope('binding'). Query: ?limit (default 50), ?cursor (resume),
// ?store_id (a store uuid | 'unmapped' | absent), ?date (today | 7d | 30d | all, default 7d),
// ?sort (newest | oldest, default newest — independent of ?date).
// Filters compose; the client resets the cursor to page 1 when either changes. Returns
// { unbound, limit, next_cursor, has_more }. Filter logic shared via @/lib/member/unbound.
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  // store_id: a real store uuid (403 if outside the member's scope), the 'unmapped' sentinel (rows
  // whose synced store_id is null — a distinct value, NOT a null param), or absent (all stores).
  const rawStore = url.searchParams.get('store_id')?.trim() || null;
  const storeUnmapped = rawStore === 'unmapped';
  const storeFilter = storeUnmapped ? null : rawStore;
  if (storeFilter && !storeIds.includes(storeFilter)) {
    return NextResponse.json({ error: 'store_id not in scope' }, { status: 403 });
  }

  // date lower bound (see dateLowerBound) and, independently, the scan direction.
  const fromTs = dateLowerBound(url.searchParams.get('date') ?? '7d');
  const desc = sortToDesc(url.searchParams.get('sort')); // default: newest-first

  const CHUNK = 300;
  const collected: UnboundRow[] = [];
  const seen = new Set<string>();
  let scanCursor: Cursor | null = cursor;
  let exhausted = false;

  try {
    // Collect until we have limit+1 matched rows (to learn has_more) or run out of captures.
    while (collected.length <= limit && !exhausted) {
      // Filters (.in, .gte, .or) must precede transforms (.order, .limit) in the builder chain.
      let filter = admin.from('capture_events').select(CAP_SELECT).in('user_id', ownerIds);
      if (fromTs) filter = filter.gte('ordered_at', fromTs); // seeds the scan AT the date bound
      if (scanCursor) filter = filter.or(keysetClause(scanCursor, desc));
      // Ordering comes from the same module as the keyset clause so the two cannot drift.
      let ordered = filter;
      for (const ob of orderBy(desc)) {
        ordered = ordered.order(ob.column, { ascending: ob.ascending, nullsFirst: ob.nullsFirst });
      }
      const { data: caps, error } = await ordered.limit(CHUNK);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const chunk = (caps ?? []) as Cap[];
      if (chunk.length < CHUNK) exhausted = true;
      if (!chunk.length) break;

      const rows = await filterUnboundChunk(admin, { ownerIds, allStores, storeIds, storeFilter, storeUnmapped }, chunk, seen);
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
