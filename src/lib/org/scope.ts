import 'server-only';
import type { SupabaseClient, User } from '@supabase/supabase-js';

// ── Which ORGANIZATION does this caller's data scope belong to? ──────────────────────────────
//
// WHY THIS EXISTS. Sub-user accounts (station, member, timeclock) and non-owner admins own no
// sales data — orders, auction items, inventory and employees all belong to the store OWNERS —
// so their routes run service-role and scope to owner user_ids resolved from
// store_members(role='owner'). That resolution had NO org boundary: it returned every store
// owner in the DATABASE. With one org and one owner that is invisible; the moment a second
// tenant owns a store (an external seller connecting their own shop), every station, member and
// chat read silently widens to include that tenant's orders — in the UI, with no error.
//
// So owner resolution is now org-bounded, and the org comes from here. This module answers ONE
// question — "which org is this caller scoped to?" — and answers it fail-closed.
//
// THE LADDER, most explicit first:
//   1. app_metadata.org_id      — explicitly stamped on the account. Always wins.
//   2. organization_members     — the caller is a real org member (owners/partners are).
//   3. assigned stores          — app_metadata.stores → stores.org_id, when they name ONE org.
//   4. sole org                 — the database contains exactly one organization, so there is
//                                 nothing to be ambiguous about. WARNS, and is the reason this
//                                 change is a no-op in production today.
//
// AND THE TRIPWIRE: if none of 1-3 resolve and the database holds TWO OR MORE organizations,
// this FAILS (500) instead of guessing. That is deliberate. A wrong guess is a cross-tenant data
// leak; a 500 is a station that stops working and gets fixed. Before a second organization
// exists, every sub-user account must carry app_metadata.org_id — see the note in
// /api/admin/team where sub-users are created.
//
// Step 1 is trusted as written: a bogus org_id resolves no stores, so callers see an empty owner
// set and fail closed on their own. It cannot widen a scope, only empty it.

export type OrgSource = 'app_metadata' | 'organization_members' | 'assigned_stores' | 'sole_org';

export type OrgScope =
  | { ok: true; orgId: string; source: OrgSource }
  | { ok: false; error: string };

type AppMetadata = { org_id?: unknown; stores?: unknown } | null | undefined;

// ── pure decisions (unit-tested directly) ────────────────────────────────────────────────────

/** Step 1: an explicitly stamped org id, or null. */
export function orgIdFromMetadata(meta: AppMetadata): string | null {
  const raw = meta?.org_id;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * The account's CONCRETE assigned store ids. The '*' sentinel means "all of the org's stores",
 * which is not a store id — it is dropped here and expressed as an absent store filter instead.
 */
export function declaredStoreIds(meta: AppMetadata): string[] {
  const raw = meta?.stores;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(String).map((s) => s.trim()).filter((s) => s !== '' && s !== '*'))];
}

/**
 * Step 3: the org named by the caller's assigned stores. Stores spanning MORE than one org is a
 * misconfigured account, not a wider scope — refuse it rather than picking one.
 */
export function orgIdFromStoreRows(rows: { org_id?: unknown }[]): OrgScope | null {
  const orgs = [...new Set(rows.map((r) => String(r.org_id ?? '')).filter(Boolean))];
  if (orgs.length === 1) return { ok: true, orgId: orgs[0], source: 'assigned_stores' };
  if (orgs.length > 1) {
    return { ok: false, error: `assigned stores span ${orgs.length} organizations; refusing to guess a data scope` };
  }
  return null; // no rows → fall through to step 4
}

/** Step 4 + the tripwire. `rows` only needs to distinguish 0 / 1 / many, so query with limit 2. */
export function soleOrgId(rows: { id?: unknown }[]): OrgScope {
  if (rows.length === 1) return { ok: true, orgId: String(rows[0].id), source: 'sole_org' };
  if (rows.length === 0) return { ok: false, error: 'no organizations exist' };
  return {
    ok: false,
    error:
      'more than one organization exists and this account is not scoped to one — ' +
      'stamp app_metadata.org_id on it (see src/lib/org/scope.ts)',
  };
}

// ── the composed resolver ────────────────────────────────────────────────────────────────────

export async function resolveScopeOrgId(admin: SupabaseClient, user: User): Promise<OrgScope> {
  const meta = user.app_metadata as AppMetadata;

  // 1. explicitly stamped
  const stamped = orgIdFromMetadata(meta);
  if (stamped) return { ok: true, orgId: stamped, source: 'app_metadata' };

  // 2. a real org membership (owners and partners have one)
  const { data: membership, error: memberErr } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (memberErr) return { ok: false, error: memberErr.message };
  if (membership?.org_id) return { ok: true, orgId: String(membership.org_id), source: 'organization_members' };

  // 3. the org that owns this account's assigned stores
  const declared = declaredStoreIds(meta);
  if (declared.length) {
    const { data: storeRows, error: storeErr } = await admin
      .from('stores')
      .select('org_id')
      .in('id', declared);
    if (storeErr) return { ok: false, error: storeErr.message };
    const fromStores = orgIdFromStoreRows(storeRows ?? []);
    if (fromStores) return fromStores;
  }

  // 4. exactly one org in the database, or fail closed
  const { data: orgRows, error: orgErr } = await admin.from('organizations').select('id').limit(2);
  if (orgErr) return { ok: false, error: orgErr.message };
  const sole = soleOrgId(orgRows ?? []);
  if (sole.ok) {
    console.warn(
      '[org-scope] user %s has no org_id, no organization_members row and no store-derived org; ' +
        'falling back to the only organization (%s). Stamp app_metadata.org_id before a second org exists.',
      user.id,
      sole.orgId,
    );
  }
  return sole;
}
