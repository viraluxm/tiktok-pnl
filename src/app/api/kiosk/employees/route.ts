import { NextResponse } from 'next/server';
import { requireTimeclockScope, clientIp } from '@/lib/kiosk/guard';
import { kioskIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// GET /api/kiosk/employees — the active employee roster for the kiosk's owner, WITH each employee's
// current attendance state, for the supervisor-gated manual picker. Service-role; owner from
// app_metadata. Non-sensitive columns ONLY — no hourly_rate / pay ever reaches the kiosk. The kiosk
// client never queries `employees` or `employee_badges` directly; it only calls this route.
export async function GET(req: Request) {
  const ip = clientIp(req);
  if (!kioskIpLimiter.check(`kiosk-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerId } = scope;

  const { data: emps, error } = await admin
    .from('employees')
    .select('id, name, role')
    .eq('user_id', ownerId)
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Derive each employee's state from their open time entry (server-side; the client never reads
  // employee_time_entries). No open entry → clocked_out.
  const { data: open, error: openErr } = await admin
    .from('employee_time_entries')
    .select('employee_id, status')
    .eq('user_id', ownerId)
    .is('clocked_out_at', null);
  if (openErr) return NextResponse.json({ error: openErr.message }, { status: 500 });

  const stateBy = new Map<string, 'working' | 'on_break'>();
  for (const e of open ?? []) {
    stateBy.set(String(e.employee_id), e.status === 'on_break' ? 'on_break' : 'working');
  }

  const employees = (emps ?? []).map((e) => ({
    id: String(e.id),
    name: String(e.name),
    role: e.role == null ? null : String(e.role),
    state: stateBy.get(String(e.id)) ?? ('clocked_out' as const),
  }));

  return NextResponse.json({ employees });
}
