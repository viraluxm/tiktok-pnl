// Pure role/confinement logic for the middleware, extracted so it can be unit-tested against the
// REAL code instead of a hand-mirrored copy (authClassification.test.mjs still mirrors the older
// predicates; everything moved here is exercised directly by claims.test.mjs).
//
// Import-free ON PURPOSE so the test can transpile this .ts at runtime without resolving any
// package — same constraint as authTimeout.ts.
//
// ─── THE ONE MISTAKE THAT MUST NEVER SHIP ───
// A Supabase access token carries TWO different things called "role":
//   • `claims.role`            → the POSTGRES role. Always the literal 'authenticated' for a
//                                signed-in user. NOT an app role.
//   • `claims.app_metadata.role` → OUR role ('station' | 'member' | 'timeclock' | 'admin' | unset).
// Reading the former would give every user role='authenticated', which is not undefined and not
// 'admin', so it falls into the fail-closed catch-all below and locks EVERY user out of the app.
// Fail-closed, so not a breach — but a total outage. claims.test.mjs asserts this explicitly.

/** The subset of JWT claims the middleware actually reads. */
export interface AuthClaims {
  /** POSTGRES role — 'authenticated'. Never the app role. Present but deliberately unused. */
  role?: string;
  exp?: number;
  sub?: string;
  app_metadata?: { role?: string; scopes?: unknown; stores?: unknown };
}

export interface Confinement {
  home: string;
  allow: string[];
}

// Station: a fixed allowlist — its own page + its own API namespace, nothing else.
export const STATION_CONFINEMENT: Confinement = { home: '/fulfillment', allow: ['/fulfillment', '/api/station'] };

// The badge time-clock kiosk account (app_metadata.role='timeclock'). THIS is the security
// boundary for the kiosk login: '/kiosk' plus '/api/kiosk/*' and nothing else. Each /api/kiosk/*
// route additionally re-checks the role via requireTimeclockScope and runs service-role,
// owner-from-app_metadata (never client input).
export const TIMECLOCK_CONFINEMENT: Confinement = { home: '/kiosk', allow: ['/kiosk', '/api/kiosk'] };

// Member reach is SCOPE-DERIVED: each scope maps 1:1 to its /team page + the owner-scoped
// /api/member/* routes THAT page uses, and a member's allowlist is the UNION over its scopes. The
// shared binding-flow routes live under the 'binding' scope that uses them. A scope this map does
// not know contributes nothing (fail closed). NOTE: '/api/team' (self-scoped fulfillment
// performance) is deliberately NOT reachable — member data comes only from owner-scoped
// /api/member/*.
export const MEMBER_SCOPE_PATHS: Record<string, string[]> = {
  binding: ['/team/binding', '/api/member/unbound', '/api/member/sessions', '/api/member/bind', '/api/member/catalog'],
  inventory: ['/team/inventory', '/api/member/inventory'],
};

/**
 * OUR app role — read from app_metadata, NEVER from the top-level `role` claim.
 * Returns undefined for an owner/admin-shaped token (no app_metadata.role), which is the
 * UNCONFINED case downstream.
 */
export function appRoleFromClaims(claims: AuthClaims | null | undefined): string | undefined {
  const r = claims?.app_metadata?.role;
  return typeof r === 'string' && r.length > 0 ? r : undefined;
}

export function memberConfinement(rawScopes: unknown): Confinement {
  const scopes = Array.isArray(rawScopes) ? rawScopes.map(String) : [];
  const allow = [...new Set(scopes.flatMap((s) => MEMBER_SCOPE_PATHS[s] ?? []))];
  const first = scopes.find((s) => MEMBER_SCOPE_PATHS[s]); // home = first RECOGNIZED scope's page
  // A member with no recognized scope gets an EMPTY allowlist and is sent to the static
  // "no areas assigned" page. Home is ALWAYS reachable (isPathAllowed below), so this page
  // renders even with an empty allowlist and never loops — unlike '/login', which would bounce
  // them straight back into the sign-in they just completed.
  return { home: first ? MEMBER_SCOPE_PATHS[first][0] : '/team/no-access', allow };
}

export function roleHomeFor(role: string | undefined, scopes: unknown): string {
  return role === 'station' ? '/fulfillment'
    : role === 'member' ? memberConfinement(scopes).home
      : role === 'timeclock' ? '/kiosk'
        : '/dashboard';
}

/**
 * Fail closed: only an unset role or 'admin' is unconfined. ANY other value — including a typo
 * like 'statoin', a member holding no recognized scope, or the POSTGRES role 'authenticated' if
 * someone ever wires the wrong claim — is a confined role with an EMPTY (or scope-limited)
 * allowlist, never full access. A new role must be added here to gain any reach.
 */
export function confinementFor(role: string | undefined, scopes: unknown): Confinement | undefined {
  if (role === undefined || role === 'admin') return undefined;
  if (role === 'station') return STATION_CONFINEMENT;
  if (role === 'member') return memberConfinement(scopes);
  if (role === 'timeclock') return TIMECLOCK_CONFINEMENT;
  return { home: '/login', allow: [] };
}

/** A confined role can always reach its own home, so the page redirect never loops. */
export function isPathAllowed(path: string, confinement: Confinement): boolean {
  return (
    path === confinement.home ||
    confinement.allow.some((p) => path === p || path.startsWith(p + '/'))
  );
}

/**
 * Freshness is decided HERE, not by the JWT library, so the middleware can tell apart:
 *   • valid + fresh   → fully authenticated
 *   • valid + expired → AUTHENTIC claims (signature verified) that are merely stale. Good enough
 *                       to keep a confined role confined, NOT good enough to call authenticated.
 * `exp` is seconds since epoch (RFC 7519).
 */
export function isExpired(claims: AuthClaims | null | undefined, nowMs: number): boolean {
  if (!claims || typeof claims.exp !== 'number') return true;
  return claims.exp * 1000 <= nowMs;
}
