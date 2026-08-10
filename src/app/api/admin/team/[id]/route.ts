import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const MANAGED_ROLES = ['member', 'station'];

// ~100 years — effectively a permanent disable. 'none' lifts the ban.
const BAN_FOREVER = '876000h';

// The only capability scopes a 'member' may hold — kept in lockstep with the create route and the
// middleware allowlist. Fail closed: an unknown scope would confine the member to nothing.
const KNOWN_MEMBER_SCOPES = ['binding', 'inventory'] as const;
function validMemberScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const set = [...new Set(raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()))];
  if (set.length === 0) return null;
  if (set.some((s) => !(KNOWN_MEMBER_SCOPES as readonly string[]).includes(s))) return null;
  return set;
}

// PATCH /api/admin/team/[id] — disable / enable / reset-password a station/member sub-user.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  let body: { action?: unknown; scopes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }
  const action = body.action;
  if (action !== 'disable' && action !== 'enable' && action !== 'reset_password' && action !== 'set_scopes') {
    return NextResponse.json({ error: "action must be 'disable', 'enable', 'reset_password', or 'set_scopes'" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Confirm the target is actually a managed (station/member) sub-user. Refuse to
  // touch an admin or a role-less user — this endpoint must never disable an
  // owner/admin account.
  const { data: target, error: getErr } = await admin.auth.admin.getUserById(id);
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 });
  if (!target?.user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const targetRole = target.user.app_metadata?.role;
  if (!targetRole || !MANAGED_ROLES.includes(targetRole)) {
    return NextResponse.json(
      { error: 'Only station/member users can be managed here' },
      { status: 403 },
    );
  }

  // Change capability scopes (member only). Validate against the known set and merge onto the
  // existing app_metadata so role + stores are preserved. Station has no scopes → refuse.
  if (action === 'set_scopes') {
    if (targetRole !== 'member') {
      return NextResponse.json({ error: 'scopes apply to members only' }, { status: 400 });
    }
    const scopes = validMemberScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json(
        { error: `scopes must be a non-empty subset of: ${KNOWN_MEMBER_SCOPES.join(', ')}` },
        { status: 400 },
      );
    }
    const nextMeta = { ...(target.user.app_metadata ?? {}), scopes };
    const { error: scErr } = await admin.auth.admin.updateUserById(id, { app_metadata: nextMeta });
    if (scErr) return NextResponse.json({ error: scErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, scopes });
  }

  // Reset password: server-generated, returned ONCE (same as the create flow). The managed-role
  // guard above already refuses admin / role-less targets, matching the disable guard.
  if (action === 'reset_password') {
    const password = randomBytes(18).toString('base64url');
    const { error: pwErr } = await admin.auth.admin.updateUserById(id, { password });
    if (pwErr) return NextResponse.json({ error: pwErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, password });
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(id, {
    ban_duration: action === 'disable' ? BAN_FOREVER : 'none',
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
