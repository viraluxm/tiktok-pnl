// Keyset pagination for the /team/binding queue. Extracted from the route so the exact filter
// string the route sends can be tested directly, rather than a parallel reimplementation of it.
//
// The sort key is COMPOSITE — (ordered_at, order_id) — and it has to be. ordered_at is not unique
// (orders land in the same millisecond during a fast lot run), and a keyset on a non-unique column
// silently duplicates or skips rows at page boundaries. order_id is the unique tiebreak, and the
// .order() calls must list both columns in the same direction as the clause below.

export type SortOrder = 'newest' | 'oldest';

/** Opaque cursor: the (ordered_at, order_id) of the last row of the previous page. */
export type Cursor = { o: string | null; i: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (c && typeof c.i === 'string' && (c.o === null || typeof c.o === 'string')) return { o: c.o, i: c.i };
  } catch { /* bad cursor → start from the beginning */ }
  return null;
}

/**
 * Keyset .or() clause resuming strictly AFTER the cursor, in the scan's direction. Both directions
 * are null-aware, matching the nullsFirst setting in `orderBy` below:
 *
 *   • desc (newest-first, nullsFirst:false → nulls sort LAST):
 *       cursor in the non-null run → everything older, the same instant with a smaller id,
 *                                    or the trailing null group
 *       cursor in the null group   → nulls with a smaller id
 *   • asc  (oldest-first, nullsFirst:true → nulls sort FIRST):
 *       cursor in the null group   → nulls with a larger id, or the whole non-null run
 *       cursor in the non-null run → everything newer, or the same instant with a larger id
 *
 * The desc side previously had NO null branch, on the assumption that desc was only ever reachable
 * with a date lower bound (which excludes null ordered_at). Making the sort user-selectable breaks
 * that assumption — "All" + newest-first is now reachable — so both branches are handled here.
 * There are no null-ordered_at rows in the queue today; this is about the clause staying correct
 * when one appears, not about a live defect.
 *
 * Timestamps are double-quoted so ':' '.' and '+' stay literal in the PostgREST filter string.
 */
export function keysetClause(cursor: Cursor, desc: boolean): string {
  if (desc) {
    return cursor.o === null
      ? `and(ordered_at.is.null,order_id.lt.${cursor.i})`
      : `ordered_at.lt."${cursor.o}",and(ordered_at.eq."${cursor.o}",order_id.lt.${cursor.i}),ordered_at.is.null`;
  }
  return cursor.o === null
    ? `and(ordered_at.is.null,order_id.gt.${cursor.i}),ordered_at.not.is.null`
    : `ordered_at.gt."${cursor.o}",and(ordered_at.eq."${cursor.o}",order_id.gt.${cursor.i})`;
}

/** The two .order() calls, as data, so the clause and the ordering can never drift apart. */
export function orderBy(desc: boolean): Array<{ column: 'ordered_at' | 'order_id'; ascending: boolean; nullsFirst: boolean }> {
  return [
    { column: 'ordered_at', ascending: !desc, nullsFirst: !desc },
    { column: 'order_id', ascending: !desc, nullsFirst: !desc },
  ];
}

/** 'newest' | 'oldest' → scan direction. Anything unrecognised falls back to the default, newest. */
export function sortToDesc(sort: string | null | undefined): boolean {
  return sort !== 'oldest';
}
