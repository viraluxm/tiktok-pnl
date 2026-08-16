import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// ~100 years — effectively a permanent disable. 'none' lifts the ban.
const BAN_FOREVER = '876000h';

// Kill / rotate / unban a KIOSK (timeclock) session in-app — so runbook lever 2 no longer needs
// Supabase Studio. Each kiosk is ONE tablet = ONE account = ONE store, and actions target a SINGLE
// account (by id), so a second kiosk that walks can be killed WITHOUT touching the first. (Disabling
// the kiosk token — /api/admin/kiosk-tokens PATCH — is the owner-wide "stop ALL punching" nuke; this
// is the per-tablet session control.)
//   kill   = ban (revokes refresh tokens) + rotate password (blocks re-login). Password returned ONCE.
//   rotate = rotate password only (recover a missed reveal; with unban, brings a killed kiosk back).
//   unban  = lift the ban.
//
// Owner-gated (unconfined: role undefined or 'admin'). Only accounts that are role='timeclock' AND
// whose app_metadata.stores intersect the owner's store_members(role='owner') stores are visible or
// actionable — never any other account.
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

type AuthUser = {
  id: string;
  email?: string;
  banned_until?: string | null;
  app_metadata?: { role?: string; stores?: unknown } | null;
};

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

function isBanned(u: AuthUser): boolean {
  return !!(u.banned_until && new Date(u.banned_until).getTime() > Date.now());
}

// GET — list the owner's kiosk accounts (one per tablet) so each can be managed independently.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const admin = createAdminClient();
  let accounts: AuthUser[];
  try { accounts = await findKioskAccounts(admin, gate.ownerId); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
  return NextResponse.json({
    accounts: accounts.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      stores: Array.isArray(u.app_metadata?.stores) ? u.app_metadata!.stores!.map(String) : [],
      banned: isBanned(u),
    })),
  });
}

// POST { action, account_id } — act on ONE kiosk account.
export async function POST(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;

  let body: { action?: unknown; account_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const action = body.action;
  const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : '';
  if (action !== 'kill' && action !== 'rotate' && action !== 'unban') {
    return NextResponse.json({ error: "action must be 'kill', 'rotate', or 'unban'" }, { status: 400 });
  }
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 });

  const admin = createAdminClient();
  let accounts: AuthUser[];
  try { accounts = await findKioskAccounts(admin, gate.ownerId); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
  const target = accounts.find((u) => u.id === accountId);
  if (!target) return NextResponse.json({ error: 'Not one of your kiosk accounts' }, { status: 404 });

  if (action === 'unban') {
    const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: 'none' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action, email: target.email ?? null });
  }

  // kill = ban + rotate; rotate = rotate only. Fresh password returned once; rotate-again is always OK.
  const password = randomBytes(18).toString('base64url');
  const patch = action === 'kill' ? { password, ban_duration: BAN_FOREVER } : { password };
  const { error } = await admin.auth.admin.updateUserById(target.id, patch);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, action, email: target.email ?? null, password });
}
