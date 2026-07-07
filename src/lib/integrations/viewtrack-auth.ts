import { timingSafeEqual } from 'node:crypto';

// Auth boundary for the ViewTrack integration endpoints. Deliberately separate
// from the cookie-session auth (`@/lib/supabase/server`): these are server-to-
// server calls carrying a shared secret, scoped to a single org via env.
//
// Env is read LAZILY here (never in the eager requireEnv block in `@/lib/env`),
// so a missing/unconfigured var 500s only the integration route instead of
// crashing the whole app at import time.

export class IntegrationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ViewTrackContext {
  orgId: string;
  systemUserId: string;
}

// Validate the Bearer secret (constant-time) and return the org + attribution
// user this credential is bound to. Throws IntegrationError on any failure.
export function assertViewTrackAuth(req: Request): ViewTrackContext {
  const secret = process.env.LENSED_VIEWTRACK_SECRET;
  const orgId = process.env.LENSED_VIEWTRACK_ORG_ID;
  const systemUserId = process.env.LENSED_VIEWTRACK_SYSTEM_USER_ID;

  // No silent fallback to org-owner: the integration user MUST be configured, so
  // attribution provably lands on it (see lensed_add_batch_admin).
  if (!secret || !orgId || !systemUserId) {
    throw new IntegrationError(500, 'Integration not configured');
  }

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new IntegrationError(401, 'Unauthorized');
  }

  return { orgId, systemUserId };
}
