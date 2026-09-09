// The capability scopes a 'member' sub-user may hold — ONE definition, imported by both admin
// routes that write them.
//
// WHY THIS FILE EXISTS. This constant was duplicated in /api/admin/team/route.ts (create) and
// /api/admin/team/[id]/route.ts (edit), and the copies DRIFTED: create accepted 2 scopes while edit
// accepted 5. The visible symptom was that P&L / Shows / Team could not be assigned at creation but
// could be added afterwards — and, until the middleware caught up, granted no reach at all. Both
// copies carried a comment promising they were "kept in lockstep". They were not, because nothing
// checked.
//
// The third place a scope must be registered is the middleware allowlist, MEMBER_SCOPE_PATHS in
// src/lib/supabase/claims.ts. That file is deliberately IMPORT-FREE (the middleware runs at the
// edge, and claims.test.mjs transpiles it standalone), so it cannot import this one. The two are
// therefore kept honest by a test instead: src/lib/member/scopes.test.mjs asserts the two sets are
// exactly equal, in both directions. A scope added here without middleware reach fails CI, and so
// does a middleware path for a scope nobody can be granted.
export const KNOWN_MEMBER_SCOPES = ['binding', 'inventory', 'pnl', 'shows', 'team'] as const;

export type MemberScopeName = (typeof KNOWN_MEMBER_SCOPES)[number];

/**
 * A non-empty, de-duplicated subset of KNOWN_MEMBER_SCOPES, or null if invalid.
 *
 * Fail closed on the whole request rather than dropping the unknown entries: a member holding no
 * RECOGNISED scope gets an empty middleware allowlist and lands on /team/no-access, so silently
 * accepting a typo would create an account that signs in successfully and can reach nothing.
 */
export function validMemberScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const set = [...new Set(raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()))];
  if (set.length === 0) return null;
  if (set.some((s) => !(KNOWN_MEMBER_SCOPES as readonly string[]).includes(s))) return null;
  return set;
}
