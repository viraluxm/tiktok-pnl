import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptOrFallback, encrypt } from '@/lib/crypto';
import { refreshAccessToken } from '@/lib/tiktok/client';

// ===== TikTok Shop token lifecycle =====
// TikTok returns access_token_expire_in / refresh_token_expire_in as ABSOLUTE Unix seconds
// (the "_in" name is misleading). The OAuth callback originally treated them as durations
// (now + expire_in*1000) → token_expires_at landed ~year 2082, masking real expiry, and no
// refresh ever ran → sync silently died once a token aged out. This module fixes both:
// expiryToIso() parses the field correctly (format-detecting, defensive), and
// getValidAccessToken() refreshes + persists (with a single-flight lock and a compare-and-swap
// on the old refresh_token so a rotated token is never clobbered).

const REFRESH_SKEW_MS = 5 * 60 * 1000;       // refresh if expiring within 5 min
const BOGUS_FUTURE_MS = 60 * 24 * 60 * 60 * 1000; // expiry > now+60d is bogus (the 2082 rows) → revalidate
const LOCK_STALE_MS = 60 * 1000;             // a held refresh lock older than this is stale
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TokenConnection {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
}

export type SyncErrorCode = 'NEEDS_RECONNECT' | 'REFRESH_FAILED' | 'FETCH_ERROR';
export type ValidTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: SyncErrorCode };

// TikTok *_expire_in is absolute Unix seconds; be defensive if a value looks like a duration.
// Access tokens are ~7 days out; refresh tokens can be years out (e.g. ~2125) — both are
// absolute epochs, so anything > 1e9 (≈ year 2001+) is treated as absolute; smaller values
// are treated as a duration-from-now (fallback for a hypothetical format change).
export function expiryToIso(expireIn: number | null | undefined): string | null {
  const v = Number(expireIn);
  if (!v || v <= 0) return null;
  if (v > 1e9) return new Date(v * 1000).toISOString();      // absolute Unix seconds
  return new Date(Date.now() + v * 1000).toISOString();       // small → duration-from-now
}

function needsRefresh(conn: TokenConnection): boolean {
  const exp = conn.token_expires_at ? Date.parse(conn.token_expires_at) : NaN;
  if (Number.isNaN(exp)) return true;                       // unknown expiry → refresh
  if (exp > Date.now() + BOGUS_FUTURE_MS) return true;      // bogus far-future (2082) → revalidate
  return exp <= Date.now() + REFRESH_SKEW_MS;               // expired / near-expiry
}

async function markError(admin: SupabaseClient, userId: string, code: SyncErrorCode, releaseLock = true) {
  const patch: Record<string, unknown> = { sync_error: code, sync_error_at: new Date().toISOString() };
  if (releaseLock) patch.token_refresh_lock_at = null;
  await admin.from('tiktok_connections').update(patch).eq('user_id', userId);
}

// Returns a usable access token, refreshing + persisting first if needed.
// `force` skips the freshness check (used by the reactive 105002 retry-once net).
export async function getValidAccessToken(
  admin: SupabaseClient,
  conn: TokenConnection,
  force = false,
): Promise<ValidTokenResult> {
  if (!force && !needsRefresh(conn)) {
    return { ok: true, accessToken: decryptOrFallback(conn.access_token, 'access_token') };
  }
  // Refresh token itself expired → cannot refresh, must re-auth.
  const rexp = conn.refresh_token_expires_at ? Date.parse(conn.refresh_token_expires_at) : NaN;
  if (!Number.isNaN(rexp) && rexp <= Date.now()) {
    await markError(admin, conn.user_id, 'NEEDS_RECONNECT');
    return { ok: false, error: 'NEEDS_RECONNECT' };
  }
  return refreshWithLock(admin, conn);
}

async function refreshWithLock(admin: SupabaseClient, conn: TokenConnection): Promise<ValidTokenResult> {
  // ---- Single-flight: claim the refresh lock via CAS (lock is null or stale) ----
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS).toISOString(); // Z-form (no '+') for .or()
  const { data: claimed } = await admin
    .from('tiktok_connections')
    .update({ token_refresh_lock_at: new Date().toISOString() })
    .eq('user_id', conn.user_id)
    .or(`token_refresh_lock_at.is.null,token_refresh_lock_at.lt.${staleBefore}`)
    .select('user_id');

  if (!claimed || claimed.length === 0) {
    // Someone else is refreshing — poll for the freshly-persisted token (up to ~10s).
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const { data } = await admin
        .from('tiktok_connections')
        .select('access_token, token_expires_at')
        .eq('user_id', conn.user_id)
        .single();
      const exp = data?.token_expires_at ? Date.parse(data.token_expires_at) : NaN;
      if (data && !Number.isNaN(exp) && exp > Date.now() + REFRESH_SKEW_MS && exp < Date.now() + BOGUS_FUTURE_MS) {
        return { ok: true, accessToken: decryptOrFallback(data.access_token, 'access_token') };
      }
    }
    return { ok: false, error: 'REFRESH_FAILED' };
  }

  // ---- We hold the lock. Refresh with the CURRENT refresh_token (R0). ----
  const r0Plain = decryptOrFallback(conn.refresh_token, 'refresh_token');
  let fresh;
  try {
    fresh = await refreshAccessToken(r0Plain);
  } catch (e) {
    console.error(`[Token] refresh rejected for ${conn.user_id} (refresh_token likely expired):`, (e as Error).message);
    await markError(admin, conn.user_id, 'NEEDS_RECONNECT');
    return { ok: false, error: 'NEEDS_RECONNECT' };
  }

  // One-time raw-response confirmation of the expiry format (verify, don't assume).
  console.log(`[Token] refresh ok for ${conn.user_id}: access_expire_in=${fresh.access_token_expire_in} → ${expiryToIso(fresh.access_token_expire_in)}; refresh_expire_in=${fresh.refresh_token_expire_in} → ${expiryToIso(fresh.refresh_token_expire_in)}`);

  const payload = {
    access_token: encrypt(fresh.access_token),
    refresh_token: encrypt(fresh.refresh_token),           // PERSIST the rotated refresh_token
    token_expires_at: expiryToIso(fresh.access_token_expire_in),
    refresh_token_expires_at: expiryToIso(fresh.refresh_token_expire_in),
    token_refresh_lock_at: null,
    sync_error: null,
    sync_error_at: null,
  };

  // ---- Persist with CAS on the OLD encrypted refresh_token; retry up to 3×. ----
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: saved, error } = await admin
      .from('tiktok_connections')
      .update(payload)
      .eq('user_id', conn.user_id)
      .eq('refresh_token', conn.refresh_token)   // CAS: only if R0 is still the stored value
      .select('user_id');
    if (!error && saved && saved.length === 1) {
      return { ok: true, accessToken: fresh.access_token };
    }
    if (!error && saved && saved.length === 0) {
      // Another writer already rotated the token — use whatever is now stored (don't clobber).
      const { data } = await admin
        .from('tiktok_connections')
        .select('access_token')
        .eq('user_id', conn.user_id)
        .single();
      if (data) return { ok: true, accessToken: decryptOrFallback(data.access_token, 'access_token') };
    }
    await sleep(300 * attempt);
  }

  // Refreshed at TikTok but could not persist → the rotated token may be lost. LOUD + reconnect.
  console.error(`[Token] CRITICAL: refreshed but FAILED TO PERSIST rotated token for ${conn.user_id} — connection may need reconnect`);
  await markError(admin, conn.user_id, 'NEEDS_RECONNECT');
  return { ok: false, error: 'NEEDS_RECONNECT' };
}
