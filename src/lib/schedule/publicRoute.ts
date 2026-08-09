import 'server-only';
import { NextResponse } from 'next/server';
import { resolveEmployeeByToken, type ResolvedEmployee } from './tokens';
import { scheduleTokenLimiter, scheduleIpLimiter, scheduleWriteLimiter } from '@/lib/rate-limit';

// Client IP from the proxy header (Vercel sets x-forwarded-for). First hop is the client.
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  return (xff?.split(',')[0].trim()) || req.headers.get('x-real-ip') || 'unknown';
}

// Rate-limit (by token AND by IP) then resolve the employee. Used by the public /s/[token] POST
// handlers. On any failure returns a NextResponse (429 / 404) the caller returns as-is; on success
// returns { resolved }. 404 is intentionally detail-free for an invalid/revoked token.
export async function guardPublicWrite(
  token: string,
  req: Request,
): Promise<{ resolved: ResolvedEmployee } | { response: NextResponse }> {
  const ip = clientIp(req);
  if (!scheduleIpLimiter.check(`sched-ip:${ip}`).success) {
    return { response: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) };
  }
  if (!scheduleTokenLimiter.check(`sched-tok:${token}`).success) {
    return { response: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) };
  }
  if (!scheduleWriteLimiter.check(`sched-write:${token}`).success) {
    return { response: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) };
  }
  const resolved = await resolveEmployeeByToken(token);
  if (!resolved) return { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  return { resolved };
}

// Read-side limiter for the page loads (token + IP, no write bucket).
export function guardPublicReadAllowed(token: string, ip: string): boolean {
  return scheduleIpLimiter.check(`sched-ip:${ip}`).success && scheduleTokenLimiter.check(`sched-tok:${token}`).success;
}

// Map a ScheduleError (or any error) to a user-facing JSON response. "Race lost" and validation
// codes are 409/400 with their message (safe to show the employee); anything else is a bare 500.
const CONFLICT_CODES = new Set(['ALREADY_CLAIMED', 'NOT_RELEASABLE']);
const BAD_REQUEST_CODES = new Set([
  'NOT_YOUR_SHIFT', 'TOO_LATE', 'WRONG_ROLE', 'OWN_RELEASE', 'ALREADY_WORKING_THAT_DAY',
  'NOT_FOUND', 'NO_TEMPLATES', 'TEMPLATE_UNAVAILABLE',
]);
export function scheduleErrorResponse(e: unknown): NextResponse {
  const code = (e as { code?: string })?.code;
  const message = (e as Error)?.message ?? 'Something went wrong';
  if (code && CONFLICT_CODES.has(code)) return NextResponse.json({ error: message, code }, { status: 409 });
  if (code && BAD_REQUEST_CODES.has(code)) return NextResponse.json({ error: message, code }, { status: 400 });
  console.error('[schedule] unexpected error:', code, message);
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}
