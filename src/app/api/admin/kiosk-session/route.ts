import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// ~100 years — effectively a permanent disable. 'none' lifts the ban.
const BAN_FOREVER = '876000h';

// Kill / rotate / unban the KIOSK (timeclock) session, in-app — so runbook lever 2 ("the tablet
// walked, kill the session") no longer requires Supabase Studio. Disabling the kiosk token
// (/api/admin/kiosk-tokens PATCH) stops PUNCHING but does NOT end the session; this ends it:
//   kill   = ban (revokes refresh tokens) + rotate password (blocks re-login). Password returned ONCE.
//   rotate = rotate password only (recover a missed reveal; also brings a banned kiosk back with unban).
//   unban  = lift the ban.
// Rotate + unban are always available, so a missed one-time reveal can never brick the kiosk.
//
// Owner-gated (unconfined session: role undefined or 'admin'). Resolves the owner's timeclock
// account(s) — role='timeclock' whose app_metadata.stores intersect the owner's store_members
// (role='owner') stores — never any other account.
async function requireOwner(): Promise<{ ok: true; ownerId: string } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, ownerId: user.id };
}

type AuthUser = { id: string; email?: string; app_metadata?: { role?: string; stores?: unknown } | null };

async function findKioskAccounts(admin: ReturnType<typeof createAdminClient>, ownerId: string): Promise<AuthUser[]> {
  const { data: sm } = await admin.from('store_members').select('store_id').eq('user_id', ownerId).eq('role', 'owner');
  const ownerStores = new Set((sm ?? []).map((r) => String(r.store_id)));
  const out: AuthUser[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const batch = (data?.users ?? []) as unknown as AuthUser[];
    for (const u of batch) {
      if (u.app_metadata?.role !== 'timeclock') continue;
      const stores = Array.isArray(u.app_metadata?.stores) ? u.app_metadata!.stores!.map(String) : [];
      if (stores.some((s) => ownerStores.has(s))) out.push(u);
    }
    if (batch.length < 200) break;
  }
  return out;
}

export async function POST(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;

  let body: { action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const action = body.action;
  if (action !== 'kill' && action !== 'rotate' && action !== 'unban') {
    return NextResponse.json({ error: "action must be 'kill', 'rotate', or 'unban'" }, { status: 400 });
  }

  const admin = createAdminClient();
  let accounts: AuthUser[];
  try {
    accounts = await findKioskAccounts(admin, gate.ownerId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!accounts.length) {
    return NextResponse.json({ error: 'No kiosk (timeclock) account found for your stores' }, { status: 404 });
  }

  const results: { email: string | null; ok: boolean; password?: string; error?: string }[] = [];
  for (const u of accounts) {
    if (action === 'unban') {
      const { error } = await admin.auth.admin.updateUserById(u.id, { ban_duration: 'none' });
      results.push({ email: u.email ?? null, ok: !error, error: error?.message });
    } else {
      // kill = ban + rotate; rotate = rotate only. A fresh password is returned once so the tablet
      // can be brought back; discard-and-rotate-again is always possible.
      const password = randomBytes(18).toString('base64url');
      const patch = action === 'kill' ? { password, ban_duration: BAN_FOREVER } : { password };
      const { error } = await admin.auth.admin.updateUserById(u.id, patch);
      results.push({ email: u.email ?? null, ok: !error, password: error ? undefined : password, error: error?.message });
    }
  }

  return NextResponse.json({ ok: results.every((r) => r.ok), action, accounts: results });
}
