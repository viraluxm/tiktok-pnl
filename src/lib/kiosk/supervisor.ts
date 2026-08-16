import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/env';

// Verify a SUPERVISOR (the store owner) by password WITHOUT establishing any session. Used by the
// kiosk exit/lock gate and by the supervisor-gated manual override.
//
// It uses a THROWAWAY anon-key supabase-js client with persistSession:false / autoRefreshToken:false
// / detectSessionInUrl:false. That client writes NO cookies and produces NO auth-state change on the
// device, so the kiosk account's own session — and, on any host machine, the capture extension's JWT
// (see CLAUDE.md) — is never touched. The password is verified and discarded; the throwaway session
// is signed out with scope:'local' so the owner's REAL sessions elsewhere are never revoked.
//
// Returns ONLY a boolean. It never returns or logs the token, session, or password. This is why the
// owner's password can be typed on the kiosk safely: nothing is established, nothing is stored.
export async function verifySupervisorIsOwner(
  email: string,
  password: string,
  ownerId: string,
): Promise<boolean> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  const verifiedUserId = data?.user?.id ?? null;

  // Drop the throwaway session immediately. scope:'local' revokes ONLY this session — never the
  // owner's other (real) sessions. Best-effort; nothing was persisted regardless.
  if (verifiedUserId) {
    try {
      await anon.auth.signOut({ scope: 'local' });
    } catch {
      /* ignore — nothing was persisted */
    }
  }

  if (error || !verifiedUserId) return false;
  // Must be THE owner resolved from the kiosk's app_metadata — never any other user, incl. another owner.
  return verifiedUserId === ownerId;
}
