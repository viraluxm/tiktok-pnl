import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getActiveStore } from '@/lib/tiktok/activeStore';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at, store_id, channel_handle, host_id';

const PAGE_SIZE = 50;

// Cursor + param validation. Values are interpolated into a PostgREST `or=` filter, so anything
// client-supplied is validated to a strict shape first (defence-in-depth; the query is already
// user-scoped by RLS + .eq('user_id')).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}T[\d:.+-]+$/; // ISO-ish; further checked with Date.parse
const isUuid = (v: string) => UUID_RE.test(v);
const isTs = (v: string) => TS_RE.test(v) && !Number.isNaN(Date.parse(v));

// Opaque keyset cursor over (started_at DESC NULLS LAST, created_at DESC, id DESC).
// started_at may be null (the trailing null bucket); created_at is NOT NULL; id is the unique tiebreak.
function encodeCursor(s: string | null, c: string, i: string): string {
  return Buffer.from(JSON.stringify([s, c, i])).toString('base64url');
}
function decodeCursor(raw: string): { s: string | null; c: string; i: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [s, c, i] = parsed;
    if (s !== null && (typeof s !== 'string' || !isTs(s))) return null;
    if (typeof c !== 'string' || !isTs(c)) return null;
    if (typeof i !== 'string' || !isUuid(i)) return null;
    return { s, c, i };
  } catch {
    return null;
  }
}

// Resolve store_id -> store name AND host_id -> employee name via manual joins, matching
// the existing pattern in src/app/api/stores/route.ts (this codebase joins by id list
// rather than using PostgREST FK embedding). Adds flat `store_name` / `host_name` (null
// when absent or not readable) so the client never has to embed/resolve.
async function attachDisplayNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const storeIds = [
    ...new Set(rows.map((r) => r.store_id).filter((v): v is string => typeof v === 'string')),
  ];
  const storeById = new Map<string, string>();
  if (storeIds.length > 0) {
    const { data: stores } = await supabase.from('stores').select('id, name').in('id', storeIds);
    for (const st of (stores ?? []) as Array<{ id: string; name: string }>) {
      storeById.set(st.id, st.name);
    }
  }
  const hostIds = [
    ...new Set(rows.map((r) => r.host_id).filter((v): v is string => typeof v === 'string')),
  ];
  const hostById = new Map<string, string>();
  if (hostIds.length > 0) {
    const { data: emps } = await supabase.from('employees').select('id, name').in('id', hostIds);
    for (const e of (emps ?? []) as Array<{ id: string; name: string }>) {
      hostById.set(e.id, e.name);
    }
  }
  return rows.map((r) => ({
    ...r,
    store_name: typeof r.store_id === 'string' ? storeById.get(r.store_id) ?? null : null,
    host_name: typeof r.host_id === 'string' ? hostById.get(r.host_id) ?? null : null,
  }));
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  // Store scope: the explicit ?store= param is the AUTHORITY for the React Query cache key (a
  // cookie-only filter wouldn't change the key, so a store switch could serve cached rows for the
  // wrong store). getActiveStore() (httpOnly cookie) is the server-side fallback/authority when the
  // param is absent. 'all' (or absent) → no store filter.
  const storeParam = url.searchParams.get('store');
  const rawStore = storeParam ?? (await getActiveStore());
  const storeFilter = rawStore && rawStore !== 'all' && isUuid(rawStore) ? rawStore : null;

  let q = supabase.from('live_sessions').select(SELECT_COLS).eq('user_id', user.id);

  // Store filter applied BEFORE the limit (the whole point of the fix). NULL store_id sessions
  // ALWAYS show — an unattributed stream must never hide behind a store selection. `.or()` on a
  // SELECT is safe (the 42703/400 bug was mutation-only).
  if (storeFilter) {
    q = q.or(`store_id.eq.${storeFilter},store_id.is.null`);
  }

  // Keyset pagination over (started_at DESC NULLS LAST, created_at DESC, id DESC). No offset.
  const cursorRaw = url.searchParams.get('cursor');
  if (cursorRaw) {
    const cur = decodeCursor(cursorRaw);
    if (cur) {
      if (cur.s === null) {
        // Cursor is inside the NULL-started bucket → page within nulls only (non-null rows all
        // precede nulls and are already served).
        q = q.is('started_at', null).or(`created_at.lt."${cur.c}",and(created_at.eq."${cur.c}",id.lt.${cur.i})`);
      } else {
        // Non-null cursor. The trailing `started_at.is.null` branch keeps null-started rows eligible;
        // NULLS LAST + LIMIT surface them only after non-null rows run out — once, never dropped,
        // never duplicated.
        q = q.or(
          `started_at.lt."${cur.s}",` +
            `and(started_at.eq."${cur.s}",created_at.lt."${cur.c}"),` +
            `and(started_at.eq."${cur.s}",created_at.eq."${cur.c}",id.lt.${cur.i}),` +
            `started_at.is.null`,
        );
      }
    }
  }

  const { data, error } = await q
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    console.error('[live/sessions] list error:', error);
    return NextResponse.json({ error: 'Failed to load sessions' }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const sessions = await attachDisplayNames(supabase, rows);
  const last = rows[rows.length - 1] as { started_at: string | null; created_at: string; id: string } | undefined;
  const nextCursor = rows.length === PAGE_SIZE && last
    ? encodeCursor(last.started_at, last.created_at, last.id)
    : null;
  return NextResponse.json({ sessions, nextCursor });
}

// Start a live session.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let title = 'Live session';
  let storeId: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.title === 'string' && body.title.trim()) {
      title = body.title.trim().slice(0, 120);
    }
    // store_id is OPTIONAL for now: honored (and validated) when a caller — e.g.
    // the extension's Start-Live flow — sends it. When absent, the set_store_id
    // trigger still backstops it. This makes the endpoint forward-compatible
    // without requiring the extension change yet.
    if (body && typeof body.store_id === 'string' && body.store_id.trim()) {
      storeId = body.store_id.trim();
    }
  } catch {
    // No body is fine; use the default title.
  }

  // A specified store must belong to the caller (guards against picking someone
  // else's store once one login owns multiple stores).
  if (storeId) {
    const { data: membership } = await supabase
      .from('store_members')
      .select('store_id')
      .eq('user_id', user.id)
      .eq('store_id', storeId)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: 'Invalid store for this user' }, { status: 400 });
    }
  }

  const nowIso = new Date().toISOString();
  const insertRow: Record<string, unknown> = {
    user_id: user.id, title, status: 'live', started_at: nowIso, source: 'manual',
  };
  // Set explicitly only when provided; otherwise the trigger backstops it.
  if (storeId) insertRow.store_id = storeId;

  const { data, error } = await supabase
    .from('live_sessions')
    .insert(insertRow)
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('[live/sessions] create error:', error);
    return NextResponse.json({ error: 'Failed to start session' }, { status: 500 });
  }
  const [session] = await attachDisplayNames(supabase, [data]);
  return NextResponse.json({ session }, { status: 201 });
}
