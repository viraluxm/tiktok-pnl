import { NextResponse } from 'next/server';
import { requireTimeclockScope, clientIp } from '@/lib/kiosk/guard';
import { verifySupervisorIsOwner } from '@/lib/kiosk/supervisor';
import { kioskSupervisorIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/kiosk/supervisor-verify — gate for the kiosk exit/lock (and the manual-override unlock).
// Verifies the SUPERVISOR (the store owner) by password server-side with NO session and NO cookie
// (see verifySupervisorIsOwner). Returns ONLY { ok }. It never returns or logs the token, session,
// or password, and this response carries NO Set-Cookie header — the kiosk account's session and any
// host machine's capture-extension JWT are untouched. Rate limited per-IP (brute-force target).
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!kioskSupervisorIpLimiter.check(`kiosk-sup-ip:${ip}`).success) {
    return NextResponse.json({ ok: false, error: 'Too many attempts' }, { status: 429 });
  }

  let body: { email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Expected JSON body' }, { status: 400 }); }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return NextResponse.json({ ok: false, error: 'Credentials required' }, { status: 400 });

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;

  const ok = await verifySupervisorIsOwner(email, password, scope.ownerId);
  return NextResponse.json({ ok });
}
