import { NextResponse } from 'next/server';
import { requireTimeclockScope, clientIp } from '@/lib/kiosk/guard';
import { verifySupervisorIsOwner } from '@/lib/kiosk/supervisor';
import { kioskRpcErrorResponse } from '@/lib/kiosk/rpc';
import { kioskSupervisorIpLimiter, kioskIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/kiosk/manual-punch — SUPERVISOR-gated manual (badgeless) punch for a lost/unusable badge,
// so no employee is ever unclockable. Records punch_method='tap' via lensed_kiosk_manual_punch_as
// (095). The supervisor (the store owner) re-authenticates by password on every override, verified
// server-side with NO session/cookie. Owner is resolved from app_metadata (never client input).
// rpc-grants: lensed_kiosk_manual_punch_as
const ACTIONS = new Set(['clock_in', 'start_break', 'end_break', 'clock_out']);

export async function POST(req: Request) {
  const ip = clientIp(req);
  // Both limiters: the supervisor-password limiter (brute force) AND the loose kiosk IP ceiling.
  if (!kioskSupervisorIpLimiter.check(`kiosk-sup-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }
  if (!kioskIpLimiter.check(`kiosk-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: { employee_id?: unknown; action?: unknown; email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const employeeId = typeof body.employee_id === 'string' ? body.employee_id.trim() : '';
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!employeeId || !ACTIONS.has(action)) {
    return NextResponse.json({ error: 'employee_id and a valid action are required' }, { status: 400 });
  }
  if (!email || !password) return NextResponse.json({ error: 'Supervisor credentials required' }, { status: 400 });

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerId } = scope;

  const authorized = await verifySupervisorIsOwner(email, password, ownerId);
  if (!authorized) {
    return NextResponse.json({ code: 'SUPERVISOR_DENIED', error: 'Supervisor not recognized' }, { status: 403 });
  }

  const { data, error } = await admin.rpc('lensed_kiosk_manual_punch_as', {
    p_owner: ownerId,
    p_employee_id: employeeId,
    p_action: action,
  });
  if (error) return kioskRpcErrorResponse(error);
  return NextResponse.json(data ?? {});
}
