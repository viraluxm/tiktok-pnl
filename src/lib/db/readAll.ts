// Read a PostgREST query to EXHAUSTION.
//
// NO IMPORTS — readAll.test.mjs transpiles this file standalone at runtime.
//
// PostgREST caps a single response at 1000 rows server-side, SILENTLY: no error, no marker,
// just a short array. Every consequence of that is a wrong number that looks right.
//
// It has already happened here. On 2026-08-31 the fulfillment performance route read 1,159
// completed boxes and got exactly 1000, reporting 2,705 SKUs instead of 3,181 — understating
// Orders, Boxes and Average Pick Time, and dividing real labor cost by a truncated box count.
// Per-show reads are next: the largest show in the last 30 days holds 1,049 auction items, the
// 95th percentile is 793, and at 5x volume 199 of 308 shows would cross the cap.
//
// TWO RULES THIS HELPER ENFORCES, both of which a hand-rolled loop tends to get wrong:
//
//   1. THE QUERY MUST BE ORDERED. Without a stable sort, PostgREST is free to return rows in
//      any order, so page 2 can repeat or skip rows from page 1 — silently corrupting the very
//      read that paging was meant to make correct. Callers pass an ordered builder; there is no
//      unordered path.
//
//   2. IT FAILS LOUD, NEVER SHORT. On a query error, or on hitting the page ceiling, this
//      THROWS. Returning what it managed to collect would reproduce exactly the bug it exists
//      to fix — a plausible-looking partial result — so partial is never a return value.

/** PostgREST's server-side response cap. Not configurable; this is the number to page around. */
export const PAGE_SIZE = 1000;

/**
 * Page ceiling. 500 pages is 500,000 rows — far beyond any read here — so hitting it means a
 * builder that ignores its range and returns the same page forever. Throwing beats spinning.
 */
const MAX_PAGES = 500;

export interface PagedResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Issue `makeQuery` repeatedly over successive row ranges until a short page proves the end.
 *
 * `makeQuery` must apply a deterministic `.order(...)` — see rule 1. It receives inclusive
 * `from`/`to` row offsets for `.range(from, to)`.
 *
 * Throws on query error or on exceeding the page ceiling. Never returns a partial read.
 */
export async function readAllPaged<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await makeQuery(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`${label}: paged read failed at offset ${from}: ${error.message}`);

    const rows = data ?? [];
    out.push(...rows);

    // A short page is the ONLY proof of exhaustion. A page of exactly PAGE_SIZE is
    // indistinguishable from a truncated one, so it must always be followed by another request
    // — even when it turns out to be empty.
    if (rows.length < PAGE_SIZE) return out;
  }

  throw new Error(
    `${label}: exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows). ` +
    'The query builder is probably ignoring its range argument.',
  );
}
