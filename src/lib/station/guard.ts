import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Resolve the store OWNERS' user_ids (and their store_ids) from store_members(role='owner').
// With no filter → every owner (the station's behavior). With { storeIds } → only owners of
// those specific stores (a member's assigned stores). Owner resolution lives in ONE place so
// station and member scopes stay consistent.
export async function resolveOwnerIds(
  admin: SupabaseClient,
  opts?: { storeIds?: string[] },
): Promise<{ ok: true; ownerIds: string[]; storeIds: string[] } | { ok: false; error: string }> {
  let q = admin.from('store_members').select('user_id, store_id').eq('role', 'owner');
  if (opts && opts.storeIds !== undefined) q = q.in('store_id', opts.storeIds);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  const rows = data ?? [];
  const ownerIds = [...new Set(rows.map((o) => String(o.user_id)))];
  const storeIds = [...new Set(rows.map((o) => String(o.store_id)))];
  return { ok: true, ownerIds, storeIds };
}

// ── station ────────────────────────────────────────────────────────────────
// Shared gate for every /api/station/* route. The station's own auth user owns NO sales data —
// orders, auction items, inventory and employees all belong to the store OWNERS — so each route
// runs with the service role, scoped to the owner user_ids resolved from store_members
// (role='owner'), NEVER to the caller.
//
// Fail closed: an empty owner set is a CONFIG failure (500 'station scope unresolved'), never a
// silent empty scan/box list.
export type StationScope =
  | { ok: true; admin: SupabaseClient; ownerIds: string[] }
  | { ok: false; response: NextResponse };

export async function requireStationScope(): Promise<StationScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'station') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const admin = createAdminClient();
  const resolved = await resolveOwnerIds(admin); // no filter → all owners (behavior unchanged)
  if (!resolved.ok) return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: 500 }) };
  if (!resolved.ownerIds.length) {
    console.error('[station] station scope unresolved: no store_members(role=owner) rows');
    return { ok: false, response: NextResponse.json({ error: 'station scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerIds: resolved.ownerIds };
}

// ── member ─────────────────────────────────────────────────────────────────
// A confined 'member' with a set of scopes and assigned stores. Gated on role==='member' AND
// app_metadata.scopes including the required scope (403 otherwise). Stores come from
// app_metadata.stores: the '*' sentinel (or unset) means ALL owner stores; otherwise only the
// listed store ids. Returns the resolved owner ids + store ids, plus `allStores` so routes can
// tell a full-scope member from a store-restricted one (store filtering needs that distinction).
export type MemberScope =
  | { ok: true; admin: SupabaseClient; ownerIds: string[]; storeIds: string[]; allStores: boolean; actorId: string }
  | { ok: false; response: NextResponse };

export async function requireMemberScope(scope: string): Promise<MemberScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const meta = (user.app_metadata ?? {}) as { role?: string; scopes?: unknown; stores?: unknown };
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String) : [];
  if (meta.role !== 'member' || !scopes.includes(scope)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const admin = createAdminClient();
  const declared = Array.isArray(meta.stores) ? meta.stores.map(String) : [];
  const allStores = declared.length === 0 || declared.includes('*'); // '*' or unset → all owner stores
  const resolved = await resolveOwnerIds(admin, allStores ? undefined : { storeIds: declared });
  if (!resolved.ok) return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: 500 }) };
  if (!resolved.ownerIds.length) {
    console.error('[member] member scope unresolved: no owner stores');
    return { ok: false, response: NextResponse.json({ error: 'member scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerIds: resolved.ownerIds, storeIds: resolved.storeIds, allStores, actorId: user.id };
}
