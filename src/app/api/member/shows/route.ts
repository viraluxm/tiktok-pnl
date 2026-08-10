import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireMemberScope } from '@/lib/station/guard';

export const dynamic = 'force-dynamic';

// Owner-scoped mirror of GET /api/live/sessions for the member 'shows' scope. Read-only session
// list; owner-scoped via ownerIds + the storeIds gate (all owner stores for an all-stores member).
// store_name / host_name resolved via admin joins (a member can't read stores/employees via RLS).
const SELECT_COLS =
  'id, title, status, started_at, ended_at, tiktok_live_id, source, created_at, updated_at, store_id, channel_handle, host_id';

async function attachDisplayNames(admin: SupabaseClient, rows: Array<Record<string, unknown>>) {
  const storeIds = [...new Set(rows.map((r) => r.store_id).filter((v): v is string => typeof v === 'string'))];
  const storeById = new Map<string, string>();
  if (storeIds.length) {
    const { data } = await admin.from('stores').select('id, name').in('id', storeIds);
    for (const st of (data ?? []) as Array<{ id: string; name: string }>) storeById.set(st.id, st.name);
  }
  const hostIds = [...new Set(rows.map((r) => r.host_id).filter((v): v is string => typeof v === 'string'))];
  const hostById = new Map<string, string>();
  if (hostIds.length) {
    const { data } = await admin.from('employees').select('id, name').in('id', hostIds);
    for (const e of (data ?? []) as Array<{ id: string; name: string }>) hostById.set(e.id, e.name);
  }
  return rows.map((r) => ({
    ...r,
    store_name: typeof r.store_id === 'string' ? storeById.get(r.store_id) ?? null : null,
    host_name: typeof r.host_id === 'string' ? hostById.get(r.host_id) ?? null : null,
  }));
}

export async function GET() {
  const scope = await requireMemberScope('shows');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  let q = admin
    .from('live_sessions')
    .select(SELECT_COLS)
    .in('user_id', ownerIds)
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);
  if (!allStores) q = q.in('store_id', storeIds);

  const { data, error } = await q;
  if (error) {
    console.error('[member/shows] list error:', error);
    return NextResponse.json({ error: 'Failed to load sessions' }, { status: 500 });
  }
  const sessions = await attachDisplayNames(admin, (data ?? []) as Array<Record<string, unknown>>);
  return NextResponse.json({ sessions });
}
