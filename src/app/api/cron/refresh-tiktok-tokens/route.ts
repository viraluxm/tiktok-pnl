import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { refreshConnection, type ConnRow } from '@/lib/tiktok/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Scheduled TikTok token refresh (Vercel cron — see vercel.json). Refreshes any
// connection whose (corrected) access token is expired or expiring soon, well before
// TikTok's ~7-day limit — the mechanism that was missing entirely (refreshAccessToken
// had zero callers), which is why both stores silently died.
//
// Runs every 6h. REFRESH_SKEW_HOURS window means a token is renewed long before it
// lapses even if a run is missed. Persist-on-success only (rotation-safe) via
// refreshConnection. A far-future expiry (year > 2050) is treated as "needs refresh"
// too, so any row still poisoned by the old unit bug self-heals on the next run.
const REFRESH_SKEW_HOURS = 24;
const BUG_FAR_FUTURE_MS = Date.now() + 366 * 24 * 3600 * 1000; // > ~1yr out ⇒ can only be the old bug

export async function GET(req: Request) {
  // Auth: Vercel cron (Bearer CRON_SECRET) or a logged-in admin. Never public.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  let authorized = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    authorized = true;
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.role === 'admin') authorized = true;
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const { data: conns, error } = await admin
    .from('tiktok_connections')
    .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at');
  if (error) return NextResponse.json({ error: `read failed: ${error.message}` }, { status: 500 });

  const skewMs = REFRESH_SKEW_HOURS * 3600 * 1000;
  const now = Date.now();
  const results: Record<string, unknown>[] = [];

  for (const c of (conns ?? []) as (ConnRow & { store_id: string | null })[]) {
    if (!c.refresh_token) { results.push({ store_id: c.store_id, action: 'skip', reason: 'no_refresh_token' }); continue; }
    const expMs = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
    const nearExpiry = !expMs || expMs - now < skewMs;
    const bugFarFuture = expMs > BUG_FAR_FUTURE_MS;
    if (!nearExpiry && !bugFarFuture) {
      results.push({ store_id: c.store_id, action: 'skip', reason: 'still_valid', token_expires_at: c.token_expires_at });
      continue;
    }
    try {
      const r = await refreshConnection(admin, c);
      results.push({ store_id: c.store_id, action: 'refreshed', reason: bugFarFuture ? 'bug_far_future_expiry' : 'near_or_past_expiry', new_token_expires_at: r.token_expires_at });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ store_id: c.store_id, action: msg === 'REFRESH_LOCKED' ? 'locked' : 'failed', error: msg });
    }
  }

  const refreshed = results.filter((r) => r.action === 'refreshed').length;
  const failed = results.filter((r) => r.action === 'failed').length;
  console.log(`[refresh-tiktok-tokens] refreshed=${refreshed} failed=${failed} total=${(conns ?? []).length}`);
  return NextResponse.json({ ok: true, refreshed, failed, total: (conns ?? []).length, results });
}
