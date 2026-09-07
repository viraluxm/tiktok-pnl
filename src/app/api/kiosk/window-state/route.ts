import { NextResponse } from 'next/server';
import { requireTimeclockScope, clientIp } from '@/lib/kiosk/guard';
import { CLOCK_ELIGIBLE_STATUSES } from '@/lib/schedule/eligibility';
import { kioskIpLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// GET /api/kiosk/window-state — drives the kiosk's idle auto-lock (Option B). Returns { locked }.
// UNLOCKED if EITHER:
//   (A) any ASSIGNED, non-released shift_instance window is currently open — now within
//       [starts_at - 45m, ends_at + 60m] (same grace as the QR/clock-in window), OR
//   (B) any employee has an OPEN time entry (clocked_out_at is null).
// (B) is load-bearing: it keeps the kiosk awake for anyone still on the clock, so a 4pm–2am shift
// that runs past ends_at + 60m never strands a clock-out behind the lock. Otherwise LOCKED — off
// hours with nobody scheduled and nobody clocked in. All timestamps are server-evaluated. Owner is
// resolved from the kiosk account's app_metadata (never client input); service-role.
export async function GET(req: Request) {
  const ip = clientIp(req);
  if (!kioskIpLimiter.check(`kiosk-ip:${ip}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const scope = await requireTimeclockScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerId } = scope;

  const now = Date.now();
  const nowPlus45 = new Date(now + 45 * 60_000).toISOString();
  const nowMinus60 = new Date(now - 60 * 60_000).toISOString();

  // (A) an assigned, CLOCK-ELIGIBLE, non-released shift whose [start-45m, end+60m] window contains
  //     now. The status filter matters: a cancelled day (a manager removed it in the Schedule
  //     Builder) is not an active schedule and must not hold the kiosk awake. See
  //     CLOCK_ELIGIBLE_STATUSES.
  const { data: win, error: e1 } = await admin
    .from('shift_instances')
    .select('id')
    .eq('user_id', ownerId)
    .not('employee_id', 'is', null)
    .is('released_at', null)
    .in('status', CLOCK_ELIGIBLE_STATUSES)
    .lte('starts_at', nowPlus45)
    .gte('ends_at', nowMinus60)
    .limit(1)
    .maybeSingle();
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (win) return NextResponse.json({ locked: false, reason: 'scheduled_window' });

  // (B) anyone currently on the clock keeps the kiosk awake.
  const { data: open, error: e2 } = await admin
    .from('employee_time_entries')
    .select('id')
    .eq('user_id', ownerId)
    .is('clocked_out_at', null)
    .limit(1)
    .maybeSingle();
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
  if (open) return NextResponse.json({ locked: false, reason: 'open_entry' });

  return NextResponse.json({ locked: true, reason: 'no_window' });
}
