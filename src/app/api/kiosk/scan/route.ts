import { NextResponse } from 'next/server';
import { requireTimeclockScope, resolveKioskToken, clientIp } from '@/lib/kiosk/guard';
import { kioskRpcErrorResponse } from '@/lib/kiosk/rpc';
import { isValidBadgeCode } from '@/lib/kiosk/badgeCode';
import { consumeQrClockCode } from '@/lib/kiosk/qrScan';
import { kioskBadgeLimiter, kioskIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/kiosk/scan — the ONE station scan handler for both credentials. An LNS1… value is a
// rotating-QR clock code (case-sensitive) → consumed + punched as 'qr'; anything else is a badge
// (091 lensed_kiosk_scan): clocked_out → clock IN, on_break → END break, working → PROMPT, rescan<60s
// → STATUS. A scan NEVER clocks out — that is an explicit button (see ./clock-out).
// rpc-grants: lensed_kiosk_scan
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!kioskIpLimiter.check(`kiosk-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: { badge?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const raw = typeof body.badge === 'string' ? body.badge.trim() : '';

  // Rotating-QR clock code branch (case preserved — the nonce is base64url).
  if (raw.startsWith('LNS1')) {
    const scope = await requireTimeclockScope();
    if (!scope.ok) return scope.response;
    return consumeQrClockCode(scope.admin, scope.ownerId, raw);
  }

  const badge = raw.toUpperCase();
  // Reject malformed scans up front — but with the SAME generic response as an unknown badge, so a
  // malformed code is indistinguishable from unknown/revoked/inactive.
  if (!isValidBadgeCode(badge)) {
    return NextResponse.json({ code: 'BADGE_NOT_RECOGNIZED', error: 'Badge not recognized — see supervisor' }, { status: 404 });
  }
  // Per-badge burst-tolerant limit (keyed on the badge, not the shared warehouse IP).
  if (!kioskBadgeLimiter.check(`kiosk-badge:${badge}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerId } = scope;

  const token = await resolveKioskToken(admin, ownerId);
  if (!token) {
    console.error('[kiosk/scan] no active kiosk_tokens row for owner %s', ownerId);
    return NextResponse.json({ code: 'KIOSK_NOT_CONFIGURED', error: 'This kiosk is not configured. See a supervisor.' }, { status: 500 });
  }

  const { data, error } = await admin.rpc('lensed_kiosk_scan', { p_kiosk_token: token, p_badge: badge });
  if (error) return kioskRpcErrorResponse(error);
  return NextResponse.json(data ?? {});
}
