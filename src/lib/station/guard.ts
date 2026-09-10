import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { declaredStoreIds, resolveScopeOrgId } from '@/lib/org/scope';

// Resolve the store OWNERS' user_ids (and their store_ids) from store_members(role='owner'),
// WITHIN ONE ORGANIZATION. Owner resolution lives in ONE place so station, member, kiosk and chat
// scopes stay consistent.
//
// `orgId` is REQUIRED and positional on purpose: it used to be absent, and "no filter" meant every
// store owner in the DATABASE. That is invisible while one tenant owns every store and becomes a
// silent cross-tenant read the moment a second one exists (an external seller connecting their own
// shop makes themselves a store owner — see the tiktok callback). Making it required means the
// compiler, not a reviewer, finds any call site that forgot to bound its scope. Resolve it with
// resolveScopeOrgId (@/lib/org/scope).
//
// Within the org: no `storeIds` → every store the org owns. With `storeIds` → only those of them
// that actually belong to the org; ids outside it are DROPPED rather than trusted, so a stale or
// hand-edited app_metadata.stores cannot reach another tenant's data.
//
// An empty result is returned as ok-with-empty, not an error: every caller already treats an empty
// owner set as a config failure and fails closed with its own message.
export async function resolveOwnerIds(
  admin: SupabaseClient,
  orgId: string,
  opts?: { storeIds?: string[] },
): Promise<{ ok: true; ownerIds: string[]; storeIds: string[] } | { ok: false; error: string }> {
  // The org's stores. PostgREST caps an unbounded select at 1000 rows; an org with more stores
  // than that would UNDER-resolve here, which narrows the scope (safe) rather than widening it.
  const { data: orgStores, error: orgErr } = await admin.from('stores').select('id').eq('org_id', orgId);
  if (orgErr) return { ok: false, error: orgErr.message };
  const orgStoreIds = new Set((orgStores ?? []).map((s) => String(s.id)));

  const scoped = opts?.storeIds === undefined
    ? [...orgStoreIds]
    : opts.storeIds.filter((id) => orgStoreIds.has(id));
  if (!scoped.length) return { ok: true, ownerIds: [], storeIds: [] };

  const { data, error } = await admin
    .from('store_members')
    .select('user_id, store_id')
    .eq('role', 'owner')
    .in('store_id', scoped);
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
  | { ok: true; admin: SupabaseClient; ownerIds: string[]; actorId: string }
  | { ok: false; response: NextResponse };

export async function requireStationScope(): Promise<StationScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'station') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const admin = createAdminClient();
  const org = await resolveScopeOrgId(admin, user);
  if (!org.ok) {
    console.error('[station] station scope unresolved: %s', org.error);
    return { ok: false, response: NextResponse.json({ error: 'station scope unresolved' }, { status: 500 }) };
  }
  // Every store the org owns — a warehouse station handles all of them — but only that org's.
  const resolved = await resolveOwnerIds(admin, org.orgId);
  if (!resolved.ok) return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: 500 }) };
  if (!resolved.ownerIds.length) {
    console.error('[station] station scope unresolved: no store_members(role=owner) rows in org %s', org.orgId);
    return { ok: false, response: NextResponse.json({ error: 'station scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerIds: resolved.ownerIds, actorId: user.id };
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

// Resolve the owner ids + assigned stores for an authenticated member. Owner resolution lives in
// ONE place (resolveOwnerIds); this wraps it with the member's store assignment. Shared by
// requireMemberScope (gated on a specific scope) and requireMember (any member scope).
async function buildMemberScope(user: User): Promise<MemberScope> {
  const admin = createAdminClient();
  const meta = (user.app_metadata ?? {}) as { stores?: unknown };
  const declared = declaredStoreIds(meta);
  const rawStores = Array.isArray(meta.stores) ? meta.stores.map(String) : [];
  // '*' or unset → all of the ORG's stores (never all stores everywhere).
  const allStores = rawStores.length === 0 || rawStores.includes('*');
  const org = await resolveScopeOrgId(admin, user);
  if (!org.ok) {
    console.error('[member] member scope unresolved: %s', org.error);
    return { ok: false, response: NextResponse.json({ error: 'member scope unresolved' }, { status: 500 }) };
  }
  const resolved = await resolveOwnerIds(admin, org.orgId, allStores ? undefined : { storeIds: declared });
  if (!resolved.ok) return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: 500 }) };
  if (!resolved.ownerIds.length) {
    console.error('[member] member scope unresolved: no owner stores in org %s', org.orgId);
    return { ok: false, response: NextResponse.json({ error: 'member scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerIds: resolved.ownerIds, storeIds: resolved.storeIds, allStores, actorId: user.id };
}

export async function requireMemberScope(scope: string): Promise<MemberScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const meta = (user.app_metadata ?? {}) as { role?: string; scopes?: unknown };
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String) : [];
  if (meta.role !== 'member' || !scopes.includes(scope)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return buildMemberScope(user);
}

// Any authenticated member, regardless of WHICH scope(s) they hold — for endpoints shared across
// scopes (e.g. /api/member/stores). The middleware already gates the PATH to scopes whose allowlist
// includes it, so reaching here means the member holds a scope granting the route; this only
// re-checks role === 'member'. Same resolved shape as requireMemberScope (owner ids + assigned
// stores), so a store-restricted member still only ever sees their own stores.
export async function requireMember(): Promise<MemberScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if ((user.app_metadata as { role?: string } | undefined)?.role !== 'member') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return buildMemberScope(user);
}
