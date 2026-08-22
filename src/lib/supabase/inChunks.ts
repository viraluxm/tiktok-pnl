// PostgREST sends `.in('col', ids)` as a URL query param, so a large id list makes a
// huge request URL. Past ~650 UUIDs the URL exceeds the server limit and the request
// 400s. Left un-chunked on a fatal join this 500s a whole page (e.g. a live show
// rendering "$0 / no items captured" — a silent failure indistinguishable from a real
// zero). Chunk every large `.in()` at 300 so the URL stays small regardless of size.
// Rows are concatenated; on the first chunk error we stop and return it so the caller
// decides whether that join is fatal or degradable.
export const IN_CHUNK = 300;

export async function inChunks<T>(
  ids: string[],
  run: (slice: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await run(ids.slice(i, i + IN_CHUNK));
    if (error) return { rows, error };
    if (data) for (const r of data) rows.push(r);
  }
  return { rows, error: null };
}

// Chunking the id list above keeps the URL legal, but it does NOT lift PostgREST's response row
// cap (`db-max-rows` = 1000 on this project — confirmed via `content-range: 0-999/139981`). A
// chunk whose result exceeds 1000 rows is silently truncated, and a truncated COST read is
// indistinguishable from a real $0 — it inflates net profit instead of erroring. Page every chunk
// with .range() until a short page comes back.
//
// The `run` callback MUST apply a stable .order() (a primary key) alongside the range: Postgres
// gives no row-order guarantee for LIMIT/OFFSET without ORDER BY, so unordered paging can repeat
// rows across pages — which on a summed cost column over-counts, strictly worse than truncating.
export const PAGE = 1000;

export async function inChunksPaged<T>(
  ids: string[],
  run: (slice: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    let offset = 0;
    for (;;) {
      const { data, error } = await run(slice, offset, offset + PAGE - 1);
      if (error) return { rows, error };
      const n = data?.length ?? 0;
      if (data) for (const r of data) rows.push(r);
      if (n < PAGE) break;
      offset += PAGE;
    }
  }
  return { rows, error: null };
}

// Same row-cap paging for a read with no `.in()` list to chunk. Same ORDER BY requirement.
export async function selectAllPages<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await run(offset, offset + PAGE - 1);
    if (error) return { rows, error };
    const n = data?.length ?? 0;
    if (data) for (const r of data) rows.push(r);
    if (n < PAGE) break;
    offset += PAGE;
  }
  return { rows, error: null };
}
