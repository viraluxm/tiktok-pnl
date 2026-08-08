import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const MANAGED_ROLES = ['va', 'station'];

// ~100 years — effectively a permanent disable. 'none' lifts the ban.
const BAN_FOREVER = '876000h';

// PATCH /api/admin/team/[id] — disable or enable a station/va sub-user.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }
  const action = body.action;
  if (action !== 'disable' && action !== 'enable') {
    return NextResponse.json({ error: "action must be 'disable' or 'enable'" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Confirm the target is actually a managed (station/va) sub-user. Refuse to
  // touch an admin or a role-less user — this endpoint must never disable an
  // owner/admin account.
  const { data: target, error: getErr } = await admin.auth.admin.getUserById(id);
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 });
  if (!target?.user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const targetRole = target.user.app_metadata?.role;
  if (!targetRole || !MANAGED_ROLES.includes(targetRole)) {
    return NextResponse.json(
      { error: 'Only station/VA users can be managed here' },
      { status: 403 },
    );
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(id, {
    ban_duration: action === 'disable' ? BAN_FOREVER : 'none',
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
