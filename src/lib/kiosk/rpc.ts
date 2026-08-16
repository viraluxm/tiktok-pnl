import { NextResponse } from 'next/server';

// Maps the stable error tokens the lensed_kiosk_* RPCs (091/092/095) raise onto kiosk HTTP responses.
//
// CRITICAL: unknown, revoked, and inactive badges ALL surface as BADGE_NOT_FOUND — the RPC's join
// filters `b.active` and `e.status='active'`, so the three cases are indistinguishable by design.
// We return ONE generic response with no name and no hint which case it was. That is the required
// behaviour ("Badge not recognized — see supervisor").
const STATE_TOKENS = [
  'ALREADY_CLOCKED_IN',
  'NOT_CLOCKED_IN',
  'ALREADY_ON_BREAK',
  'NOT_ON_BREAK',
  'BREAK_OPEN',
  'INVALID_ACTION',
];

export function kioskRpcErrorResponse(error: { message?: string; code?: string }): NextResponse {
  const msg = error?.message ?? '';

  if (msg.includes('BADGE_NOT_FOUND')) {
    // Unknown / revoked / inactive — identical generic response. No name, no distinction.
    return NextResponse.json(
      { code: 'BADGE_NOT_RECOGNIZED', error: 'Badge not recognized — see supervisor' },
      { status: 404 },
    );
  }
  if (msg.includes('INVALID_KIOSK') || msg.includes('INVALID_OWNER')) {
    // Provisioning fault (no active kiosk_tokens row / bad owner) — not an employee-facing badge issue.
    console.error('[kiosk] provisioning fault:', error.code, msg);
    return NextResponse.json(
      { code: 'KIOSK_NOT_CONFIGURED', error: 'This kiosk is not configured. See a supervisor.' },
      { status: 500 },
    );
  }
  if (msg.includes('EMPLOYEE_NOT_FOUND')) {
    return NextResponse.json({ code: 'EMPLOYEE_NOT_FOUND', error: 'Employee not found' }, { status: 404 });
  }
  const token = STATE_TOKENS.find((t) => msg.includes(t));
  if (token) {
    // State-machine tokens: the client already has the employee name from the identifying scan and
    // renders a friendly, name-personalised message (see src/lib/timeclock.ts friendlyClockError).
    return NextResponse.json({ code: token, error: token }, { status: 409 });
  }
  console.error('[kiosk] rpc error:', error.code, msg);
  return NextResponse.json({ code: 'UNKNOWN', error: 'Something went wrong. Please try again.' }, { status: 500 });
}
