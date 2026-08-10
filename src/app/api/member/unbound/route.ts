import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { CAP_SELECT, filterUnboundChunk, type Cap, type UnboundRow } from '@/lib/member/unbound';

export const dynamic = 'force-dynamic';

const TZ = 'America/Los_Angeles';

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

// Keyset .or() clause resuming strictly AFTER the cursor, in the scan's direction:
//   • desc (date-filtered, newest-first): ordered_at < o, OR (ordered_at = o AND order_id < i).
//     ordered_at is never null here (the date lower bound excludes the lone null-ordered_at row),
//     so no null branch is needed.
//   • asc (the 'All' view, oldest-first): the original null-aware clause — cursor.o === null means
//     we're still in the leading NULL-ordered_at group. Timestamps are double-quoted so ':'/'.'/'+'
//     are literal in the filter string.
function keysetClause(cursor: Cursor, desc: boolean): string {
  if (desc) {
    return `ordered_at.lt."${cursor.o}",and(ordered_at.eq."${cursor.o}",order_id.lt.${cursor.i})`;
  }
  return cursor.o === null
    ? `and(ordered_at.is.null,order_id.gt.${cursor.i}),ordered_at.not.is.null`
    : `ordered_at.gt."${cursor.o}",and(ordered_at.eq."${cursor.o}",order_id.gt.${cursor.i})`;
}

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

// date pill → lower bound + scan direction. 'all' keeps the original oldest-first scan with NO
// bound (backlog view). today/7d/30d scan NEWEST-FIRST and are bounded at the PT day-start, so the
// scan seeds AT the bound instead of iterating the whole oldest-first prefix and discarding.
function dateWindow(date: string): { fromTs: string | null; desc: boolean } {
  switch (date) {
    case 'today': return { fromTs: ptDayStartISO(0), desc: true };
    case '30d': return { fromTs: ptDayStartISO(29), desc: true };
    case 'all': return { fromTs: null, desc: false };
    case '7d':
    default: return { fromTs: ptDayStartISO(6), desc: true };
  }
}

// GET /api/member/unbound — cross-session binding queue, KEYSET-paginated. Owner-scoped
// (service_role), requireMemberScope('binding'). Query: ?limit (default 50), ?cursor (resume),
// ?store_id (a store uuid | 'unmapped' | absent), ?date (today | 7d | 30d | all, default 7d).
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

  // date lower bound + direction (see dateWindow).
  const { fromTs, desc } = dateWindow(url.searchParams.get('date') ?? '7d');

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
      const ordered = desc
        ? filter.order('ordered_at', { ascending: false, nullsFirst: false }).order('order_id', { ascending: false })
        : filter.order('ordered_at', { ascending: true, nullsFirst: true }).order('order_id', { ascending: true });
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
