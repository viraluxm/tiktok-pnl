import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolvePracticeHostToken, type ResolvedHostSession } from '@/lib/training/hostToken';

// Shared gate for every /api/host/[token]/* route.
//
// WHY THIS IS A SEPARATE NAMESPACE FROM /api/admin/training/*, RATHER THAN AN EXTRA
// AUTH MODE ON THOSE ROUTES. A route that accepts "either an admin session or a
// token" has two security paths through one body of code, and the failure mode is
// silent: a mistake makes the weaker path apply to the stronger route. Keeping them
// physically separate means each route has exactly one way in, and reviewing the
// tokenised surface means reading this directory and nothing else.
//
// Every route here is cookieless by construction — middleware excludes api/host/,
// no auth client is constructed, and nothing reads or writes a session cookie. The
// token in the path is the only credential.
export type HostScope =
  | { ok: true; admin: SupabaseClient; session: ResolvedHostSession }
  | { ok: false; response: NextResponse };

export async function requireHostToken(
  params: Promise<{ token: string }>,
): Promise<HostScope> {
  const { token } = await params;
  const session = await resolvePracticeHostToken(token);
  // One response for every miss — unknown token, or a session already ended. A
  // caller must not be able to tell those apart, or the endpoint becomes an oracle
  // for which tokens exist.
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return { ok: true, admin: createAdminClient(), session };
}
