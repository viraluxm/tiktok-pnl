import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// GET /api/admin/reports/punch-methods?from=ISO&to=ISO — per-employee counts of tap / badge / qr
// punches (by clock-in) in a window; defaults to the last 14 days (one pay period). Once QR is the
// default path, a badge count staying high is the signal to revisit PIN. Owner-gated.
async function requireOwner(): Promise<{ ok: true; ownerId: string } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { ok: true, ownerId: user.id };
}

export async function GET(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const toD = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
  const fromD = url.searchParams.get('from')
    ? new Date(url.searchParams.get('from')!)
    : new Date(toD.getTime() - 14 * 86_400_000);

  const admin = createAdminClient();
  const { data: entries, error } = await admin
    .from('employee_time_entries')
    .select('employee_id, punch_method')
    .eq('user_id', gate.ownerId)
    .gte('clocked_in_at', fromD.toISOString())
    .lte('clocked_in_at', toD.toISOString());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: emps } = await admin.from('employees').select('id, name').eq('user_id', gate.ownerId);
  const nameById = new Map((emps ?? []).map((e) => [String(e.id), String(e.name)]));

  const byEmp = new Map<string, { tap: number; badge: number; qr: number }>();
  for (const r of entries ?? []) {
    const id = String(r.employee_id);
    const c = byEmp.get(id) ?? { tap: 0, badge: 0, qr: 0 };
    const m = String(r.punch_method) as 'tap' | 'badge' | 'qr';
    if (m === 'tap' || m === 'badge' || m === 'qr') c[m] += 1;
    byEmp.set(id, c);
  }
  const rows = [...byEmp.entries()]
    .map(([id, c]) => ({ employee: nameById.get(id) ?? id, ...c, total: c.tap + c.badge + c.qr }))
    .sort((a, b) => b.badge - a.badge);

  return NextResponse.json({ from: fromD.toISOString(), to: toD.toISOString(), rows });
}
