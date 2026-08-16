import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateBadgeCode } from '@/lib/kiosk/badgeCode';

export const dynamic = 'force-dynamic';

// Owner-only badge administration (issue / list / revoke). Runs under the OWNER's authenticated
// session — NOT the kiosk account. "Owner" = an unconfined session (role undefined or 'admin'); the
// confined sub-user roles (station/member/timeclock) are rejected. All writes are scoped explicitly
// to the owner's user_id (employee_badges also has own-row RLS as a backstop).
//
// Codes are revoked (active=false), never deleted and never reused — the global UNIQUE(code) from
// migration 091 guarantees a revoked code can never be reissued to a different employee.
async function requireOwner(): Promise<
  { ok: true; ownerId: string } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, ownerId: user.id };
}

// GET /api/admin/badges — every badge (active + revoked) for the owner's employees.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('employee_badges')
    .select('id, employee_id, code, active, issued_at, revoked_at')
    .eq('user_id', gate.ownerId)
    .order('issued_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ badges: data ?? [] });
}

// POST /api/admin/badges { employee_id } — issue a fresh badge for one of the owner's active
// employees. Retries on the (astronomically unlikely) code collision the global UNIQUE would raise.
export async function POST(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { ownerId } = gate;

  let body: { employee_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const employeeId = typeof body.employee_id === 'string' ? body.employee_id.trim() : '';
  if (!employeeId) return NextResponse.json({ error: 'employee_id required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: emp, error: empErr } = await admin
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('user_id', ownerId)
    .eq('status', 'active')
    .maybeSingle();
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });
  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateBadgeCode();
    const { data, error } = await admin
      .from('employee_badges')
      .insert({ user_id: ownerId, employee_id: employeeId, code, active: true })
      .select('id, code')
      .single();
    if (!error) return NextResponse.json({ ok: true, id: data.id, code: data.code, employee_id: employeeId });
    if (error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });
    // 23505 = duplicate code (global or active-partial unique) — regenerate and retry.
  }
  console.error('[admin/badges] could not allocate a unique code after retries');
  return NextResponse.json({ error: 'Could not allocate a badge code, please retry' }, { status: 500 });
}

// PATCH /api/admin/badges { badge_id } — revoke a badge (active=false, revoked_at=now). Reissue is
// revoke + POST a new one; the old code is never reused.
export async function PATCH(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { ownerId } = gate;

  let body: { badge_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const badgeId = typeof body.badge_id === 'string' ? body.badge_id.trim() : '';
  if (!badgeId) return NextResponse.json({ error: 'badge_id required' }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('employee_badges')
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq('id', badgeId)
    .eq('user_id', ownerId)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Badge not found' }, { status: 404 });
  return NextResponse.json({ ok: true, id: data.id });
}
