import { createAdminClient } from '@/lib/supabase/admin';
import { encrypt, decryptOrFallback } from '@/lib/crypto';
import { refreshAccessToken, type TikTokShopTokenResponse } from '@/lib/tiktok/client';

// Shared TikTok Shop token lifecycle: correct expiry math + refresh-with-persist.
//
// CRITICAL — expiry unit bug (the ~2083 incident): TikTok Shop returns
// access_token_expire_in / refresh_token_expire_in as ABSOLUTE Unix epoch SECONDS
// (the moment it expires), NOT a relative duration. The old callback did
// `Date.now() + access_token_expire_in * 1000`, double-counting the epoch → year ~2081.
// The stored 2081/2083 then made every "is it near expiry?" check read "valid forever",
// so nothing ever refreshed and tokens silently died at TikTok's real ~7-day limit.
//
// ACCESS: token expires at new Date(access_token_expire_in * 1000). Never add Date.now().
//
// REFRESH DEADLINE — deliberately NOT from refresh_token_expire_in. TikTok returns that as a
// truthful but useless absolute epoch ~year 2125 (~99 years out), yet the refresh token
// operationally dies ~28 days after issuance (observed: two stores connected 07-06 died 08-03).
// So the usable re-auth deadline is issuance + 28d. Whether a rotation resets that clock is
// unconfirmed (see the ~09-01 observation); until then we treat it as a hard cap from issuance —
// the SAFE default (warns to re-auth) rather than the optimistic "far future" that hid the death.
export const REFRESH_TOKEN_TTL_DAYS = 28;
export function expiriesFromToken(t: TikTokShopTokenResponse): {
  token_expires_at: string;
  refresh_token_expires_at: string | null;
} {
  return {
    token_expires_at: new Date(t.access_token_expire_in * 1000).toISOString(),
    refresh_token_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
  };
}

// The stored shape refreshConnection needs. `access_token`/`refresh_token` are the
// ENCRYPTED column values; `token_expires_at` is the (corrected) absolute expiry.
export interface ConnRow {
  id: string;
  access_token: string;
  refresh_token: string | null;
  shop_cipher: string | null;
  token_expires_at: string | null;
}

const LOCK_STALE_MS = 2 * 60 * 1000; // a refresh lock older than this is considered abandoned

export interface RefreshResult {
  accessToken: string;
  shopCipher: string | null;
  token_expires_at: string;
  refresh_token_expires_at: string | null;
}

// Refresh a connection's access token via its refresh token and PERSIST the result.
// PERSIST-ON-SUCCESS ONLY: TikTok rotates the refresh token on use, so a successful
// refresh MUST save the NEW refresh_token immediately (else the rotated token is burned
// and the connection needs full re-auth). On failure we persist NOTHING (only release the
// lock), so a dead refresh token leaves the row untouched → caller falls back to re-auth.
//
// Concurrency: a best-effort lock via token_refresh_lock_at (claimed only if null/stale)
// prevents two refreshers from racing (and double-rotating) the same connection.
export async function refreshConnection(
  admin: ReturnType<typeof createAdminClient>,
  conn: ConnRow,
): Promise<RefreshResult> {
  if (!conn.refresh_token) throw new Error('NO_REFRESH_TOKEN');

  // Claim the lock: set lock=now only where it's null or older than LOCK_STALE_MS.
  const staleCutoff = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data: claimed } = await admin
    .from('tiktok_connections')
    .update({ token_refresh_lock_at: new Date().toISOString() })
    .eq('id', conn.id)
    .or(`token_refresh_lock_at.is.null,token_refresh_lock_at.lt.${staleCutoff}`)
    .select('id');
  if (!claimed || claimed.length === 0) throw new Error('REFRESH_LOCKED'); // another refresher holds it

  try {
    const refreshTokenPlain = decryptOrFallback(conn.refresh_token, 'refresh_token');
    // Throws on a TikTok error (incl. an expired/invalid refresh token) → we persist nothing.
    const tokenData = await refreshAccessToken(refreshTokenPlain);
    const exp = expiriesFromToken(tokenData);

    const { error: upErr } = await admin
      .from('tiktok_connections')
      .update({
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token), // ROTATION: store the new refresh token
        token_expires_at: exp.token_expires_at,
        // NOTE: intentionally do NOT touch refresh_token_expires_at here. The re-auth deadline is
        // issuance + 28d, stamped at connect; a refresh must not silently extend it (that would be
        // the unproven "rolling" assumption). If the ~09-01 observation shows rotation resets the
        // clock, extend it here then.
        token_refresh_lock_at: null, // release
      })
      .eq('id', conn.id);
    if (upErr) throw new Error(`persist failed after refresh: ${upErr.message}`);
    // Rotation telemetry (instrument the 09-01 observation): each success rotates the refresh token.
    console.log(`[token-rotate] store=${(conn as { store_id?: string }).store_id ?? conn.id} rotated refresh_token; access exp ${exp.token_expires_at}`);

    return { accessToken: tokenData.access_token, shopCipher: conn.shop_cipher, ...exp };
  } catch (e) {
    // Release the lock; persist nothing else (the stored refresh token stays as-is on failure).
    await admin.from('tiktok_connections').update({ token_refresh_lock_at: null }).eq('id', conn.id);
    throw e;
  }
}

// Return a usable access token for a connection, refreshing proactively when the stored
// (corrected) expiry is within `skewMinutes`. If refresh fails, falls back to the current
// stored token (the caller's 105002 retry is the real safety net for a wrong stored expiry).
export async function getFreshToken(
  admin: ReturnType<typeof createAdminClient>,
  conn: ConnRow,
  opts: { skewMinutes?: number } = {},
): Promise<{ accessToken: string; shopCipher: string | null }> {
  const skewMs = (opts.skewMinutes ?? 30) * 60 * 1000;
  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  const nearExpiry = !expMs || expMs - Date.now() < skewMs;
  if (nearExpiry && conn.refresh_token) {
    try {
      const r = await refreshConnection(admin, conn);
      return { accessToken: r.accessToken, shopCipher: r.shopCipher };
    } catch {
      /* fall through — use the current token; a 105002 retry will refresh if truly expired */
    }
  }
  return { accessToken: decryptOrFallback(conn.access_token, 'access_token'), shopCipher: conn.shop_cipher };
}

// Detect TikTok's "expired credentials" from a thrown shopGet error (message carries the code).
export function isExpiredCredsError(e: unknown): boolean {
  return e instanceof Error && /105002|Expired credentials/i.test(e.message);
}
