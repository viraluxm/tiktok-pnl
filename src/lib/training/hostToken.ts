import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

// PUBLIC-TOKEN identity resolution for the /p/[token] practice-host route.
//
// Mirrors src/lib/schedule/tokens.ts deliberately: this route NEVER establishes a
// Supabase auth session (see CLAUDE.md). The token resolves a session SERVER-SIDE
// via the service-role client, and every downstream query is then filtered
// explicitly by the resolved session id and owner. Service-role bypasses RLS, so
// RLS is NOT the security boundary here — the token plus those explicit filters is.
//
// WHY A TOKEN AND NOT THE SESSION ID. The session id is already public: it appears
// in the admin URL, in the Realtime channel name (`trainer:<id>`) and in the LiveKit
// room name (`training:<id>`). Using it as the credential would mean anyone who saw
// a screenshot of the controller could join as host. A separate high-entropy secret
// is what makes the link safe to send to someone outside the company.

// 32 random bytes, base64url (43 chars, no padding). Generated in app code, never
// in the DB — same as generateAccessToken() for employee tokens.
export function generatePracticeHostToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface ResolvedHostSession {
  sessionId: string;
  ownerId: string;
  traineeName: string | null;
}

// Resolve a token to its LIVE session.
//
// Returns null for every miss — unknown token, or a session that has already ended —
// and the caller renders a bare 404 that leaks nothing about which of the two it was.
// Refusing an ended session is what makes the link self-revoking: there is
// deliberately no expiry column, because ended_at already answers the same question
// and a second source of truth would eventually disagree with the first.
export async function resolvePracticeHostToken(
  token: string | undefined,
): Promise<ResolvedHostSession | null> {
  // Cheap reject before touching the database. A real token is 43 chars.
  if (!token || token.length < 20) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .select('id, owner_id, trainee_name, ended_at')
    .eq('host_token', token)
    .maybeSingle();

  if (error || !data) return null;
  // An ended session's link is dead. Note this is checked here rather than in the
  // query so that a re-opened session (restartPractice clears ended_at) works again
  // without minting a new token.
  if (data.ended_at !== null) return null;

  return {
    sessionId: data.id as string,
    ownerId: data.owner_id as string,
    traineeName: (data.trainee_name as string | null) ?? null,
  };
}
