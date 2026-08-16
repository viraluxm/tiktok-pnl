import { NextResponse } from 'next/server';
import { requireTimeclockScope, resolveKioskToken, clientIp } from '@/lib/kiosk/guard';
import { kioskRpcErrorResponse } from '@/lib/kiosk/rpc';
import { isValidBadgeCode } from '@/lib/kiosk/badgeCode';
import { kioskBadgeLimiter, kioskIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/kiosk/clock-out — explicit "Clock out" button after an identifying scan showed the
// working PROMPT. A scan can never reach here — clock-out is always a deliberate button press.
// Service-role; owner from app_metadata. rpc-grants: lensed_kiosk_clock_out
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!kioskIpLimiter.check(`kiosk-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: { badge?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const badge = typeof body.badge === 'string' ? body.badge.trim().toUpperCase() : '';
  if (!isValidBadgeCode(badge)) {
    return NextResponse.json({ code: 'BADGE_NOT_RECOGNIZED', error: 'Badge not recognized — see supervisor' }, { status: 404 });
  }
  if (!kioskBadgeLimiter.check(`kiosk-badge:${badge}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerId } = scope;

  const token = await resolveKioskToken(admin, ownerId);
  if (!token) {
    console.error('[kiosk/clock-out] no active kiosk_tokens row for owner %s', ownerId);
    return NextResponse.json({ code: 'KIOSK_NOT_CONFIGURED', error: 'This kiosk is not configured. See a supervisor.' }, { status: 500 });
  }

  const { data, error } = await admin.rpc('lensed_kiosk_clock_out', { p_kiosk_token: token, p_badge: badge });
  if (error) return kioskRpcErrorResponse(error);
  return NextResponse.json(data ?? {});
}
