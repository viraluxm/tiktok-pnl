import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOwnerIds } from '@/lib/station/guard';

// ── kiosk (badge time clock) ─────────────────────────────────────────────────
// Shared gate for every /api/kiosk/* route. The kiosk runs as a dedicated 'timeclock' login account
// (app_metadata.role='timeclock') that owns NO data — employees, punches and badges all belong to the
// store OWNER. We resolve that owner from the account's app_metadata.stores via store_members
// (role='owner'), NEVER from client input, and every route runs service-role scoped to that one owner.
//
// Fail closed: no stores, or an owner set that isn't exactly one, is a 500 — never a silent
// cross-owner read. (A kiosk is one physical location serving one owner.)
export type TimeclockScope =
  | { ok: true; admin: SupabaseClient; ownerId: string; storeIds: string[]; actorId: string }
  | { ok: false; response: NextResponse };

export async function requireTimeclockScope(): Promise<TimeclockScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'timeclock') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const meta = (user.app_metadata ?? {}) as { stores?: unknown };
  const declared = Array.isArray(meta.stores)
    ? meta.stores.map(String).filter((s) => s && s !== '*')
    : [];
  if (declared.length === 0) {
    console.error('[kiosk] timeclock account has no concrete stores in app_metadata');
    return { ok: false, response: NextResponse.json({ error: 'kiosk scope unresolved' }, { status: 500 }) };
  }

  const admin = createAdminClient();
  const resolved = await resolveOwnerIds(admin, { storeIds: declared });
  if (!resolved.ok) return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: 500 }) };
  if (resolved.ownerIds.length !== 1) {
    console.error('[kiosk] expected exactly one owner for stores %o, got %d', declared, resolved.ownerIds.length);
    return { ok: false, response: NextResponse.json({ error: 'kiosk scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerId: resolved.ownerIds[0], storeIds: resolved.storeIds, actorId: user.id };
}

// Internal owner→token lookup. In the login-account model, kiosk_tokens is NOT a URL gate — 091's
// original public /k/[kiosk_token] design is SUPERSEDED. The owner is already established by the
// authenticated 'timeclock' session; here we just fetch that owner's active kiosk token to hand to
// the service-role lensed_kiosk_* RPCs, which still resolve the owner FROM the token (unmodified).
// The token never appears in a URL and never reaches the client.
export async function resolveKioskToken(admin: SupabaseClient, ownerId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('kiosk_tokens')
    .select('token')
    .eq('user_id', ownerId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[kiosk] token lookup failed:', error.message);
    return null;
  }
  return data?.token ? String(data.token) : null;
}

// Client IP from the proxy header (Vercel sets x-forwarded-for; first hop is the client).
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  return xff?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}
