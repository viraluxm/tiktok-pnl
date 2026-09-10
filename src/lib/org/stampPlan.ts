// Which existing sub-user accounts get an app_metadata.org_id, and which are left alone.
//
// WHY. Sub-user accounts (station, member, timeclock) own no sales data, so their routes resolve
// the store OWNERS and read as them. That resolution is being bounded to one organization, and the
// org is resolved from a ladder whose first and only unambiguous rung is a stamped
// app_metadata.org_id. Every other rung is an inference. While exactly one organization exists the
// inference is safe; the moment a second one exists, an unstamped sub-user must fail closed rather
// than guess. So the accounts have to be stamped BEFORE a second organization is created, and this
// is the plan for doing it to the accounts that already exist.
//
// THE ONE RULE THAT MATTERS: only the three managed sub-user roles are ever touched. Not the
// owner, not an admin, not a role-less account. The owner's account is the identity whose JWT the
// capture extension holds, and app_metadata travels in that JWT — so "never write to the owner" is
// not tidiness, it is the reason this can be run at all. Everything else is skipped by name, with
// a reason, so the dry-run output is a list of decisions rather than a list of writes.
//
// Pure and import-free so it is unit-testable, and so the dry-run and the real run plan
// IDENTICALLY — the script's only branch on --apply is whether it performs the writes.

/** The roles created by /api/admin/team. Exactly these, and nothing else, may be stamped. */
export const STAMPABLE_ROLES = ['member', 'station', 'timeclock'] as const;

export interface AccountLike {
  id: string;
  email: string | null;
  role: string | null;
  orgId: string | null;
}

export type SkipReason =
  /** Not a managed sub-user: the owner, an admin, or a role-less account. Never touched. */
  | 'not-a-sub-user'
  /** Already carries an org_id — the plan is idempotent, so a re-run is a no-op. */
  | 'already-stamped';

export type Action =
  | { kind: 'stamp'; account: AccountLike; orgId: string }
  | { kind: 'skip'; account: AccountLike; reason: SkipReason };

export interface Plan {
  actions: Action[];
  toStamp: Extract<Action, { kind: 'stamp' }>[];
  orgId: string;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

export function isStampable(role: string | null): boolean {
  return role !== null && (STAMPABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Plan the stamp for a single organization.
 *
 * Refuses outright unless the database holds EXACTLY ONE organization. With none there is nothing
 * to stamp; with two or more, "which org does this station belong to?" is a real question with a
 * real answer per account, and a script that picks one would be guessing at precisely the moment
 * guessing became a cross-tenant read. That case is a deliberate manual job.
 */
export function planOrgIdStamp(accounts: AccountLike[], orgIds: string[]): PlanResult {
  const orgs = [...new Set(orgIds.filter(Boolean))];
  if (orgs.length === 0) return { ok: false, error: 'no organizations exist — nothing to stamp' };
  if (orgs.length > 1) {
    return {
      ok: false,
      error:
        `${orgs.length} organizations exist (${orgs.join(', ')}) — refusing to guess. ` +
        'Stamp each sub-user with its own org by hand; a script cannot know which tenant a ' +
        'station belongs to once there is more than one.',
    };
  }
  const orgId = orgs[0];

  const actions: Action[] = accounts.map((account) => {
    if (!isStampable(account.role)) return { kind: 'skip', account, reason: 'not-a-sub-user' };
    if (account.orgId) return { kind: 'skip', account, reason: 'already-stamped' };
    return { kind: 'stamp', account, orgId };
  });

  return {
    ok: true,
    plan: {
      actions,
      toStamp: actions.filter((a): a is Extract<Action, { kind: 'stamp' }> => a.kind === 'stamp'),
      orgId,
    },
  };
}
