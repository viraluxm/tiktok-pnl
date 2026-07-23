import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at, store_id, channel_handle, host_id';

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

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('live_sessions')
    .select(SELECT_COLS)
    .eq('user_id', user.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[live/sessions] list error:', error);
    return NextResponse.json({ error: 'Failed to load sessions' }, { status: 500 });
  }
  const sessions = await attachDisplayNames(supabase, data ?? []);
  return NextResponse.json({ sessions });
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
