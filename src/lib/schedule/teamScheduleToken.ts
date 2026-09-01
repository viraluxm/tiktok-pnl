import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

// PUBLIC-TOKEN identity resolution for /s/team/[token] — the read-only team schedule link.
//
// Same contract as src/lib/schedule/tokens.ts: the route NEVER establishes a Supabase auth
// session, resolves the OWNER from an opaque token via the service-role client, and then scopes
// every downstream query explicitly by that owner id. Service-role bypasses RLS, so RLS is not
// the boundary here — the token plus the explicit user_id filter is.

export function generateTeamScheduleToken(): string {
  return randomBytes(32).toString('base64url'); // 43 chars, no padding
}

// Resolve an ACTIVE token to the owning account id. Any miss returns null and the caller renders
// a bare 404 — an unknown, revoked, or malformed token must be indistinguishable.
export async function resolveOwnerByScheduleToken(token: string): Promise<string | null> {
  if (!token || token.length < 20) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('team_schedule_tokens')
    .select('user_id')
    .eq('token', token)
    .eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  return String(data.user_id);
}
