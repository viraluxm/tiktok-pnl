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
