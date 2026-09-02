import { NextResponse } from 'next/server';
import { guardPublicWrite, guardPublicReadAllowed, clientIp } from '@/lib/schedule/publicRoute';
import { resolveEmployeeByToken } from '@/lib/schedule/tokens';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import { laTodayISO } from '@/lib/schedule/timezone';
import { checkTimeOffWindow, timeOffRejectMessage, earliestRequestableDate } from '@/lib/schedule/timeOff';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON = 300;

// Public schedule-link surface — NO Supabase auth session is established here (see CLAUDE.md).
// Identity comes from the opaque access token; the service-role client is then scoped explicitly
// by that employee_id in every query. RLS is bypassed by service-role and is never the boundary.

// GET — this worker's own requests, plus the earliest date the form may offer.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!guardPublicReadAllowed(token, clientIp(req))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }
  const resolved = await resolveEmployeeByToken(token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const emp = resolved.employee;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_off_requests')
    .select('id, start_date, end_date, reason, status, decision_note, created_at')
    .eq('employee_id', emp.id)
    .eq('user_id', emp.user_id)
    .neq('status', 'withdrawn')
    .order('start_date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const today = laTodayISO();
  return NextResponse.json({
    requests: data ?? [],
    earliest: earliestRequestableDate(today, payPeriodStartFor),
  });
}

// POST { start_date, end_date, reason? } — submit a request.
//
// The window rule is enforced HERE against the server's own clock and the real pay-period anchor.
// The client shows the same bound only so the date picker is usable; it is never trusted.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  if (employee.status !== 'active') {
    return NextResponse.json({ error: 'Not available' }, { status: 403 });
  }

  let body: { start_date?: unknown; end_date?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const startDate = typeof body.start_date === 'string' ? body.start_date.trim() : '';
  // A single-day request may omit end_date entirely.
  const endDate = typeof body.end_date === 'string' && body.end_date.trim() ? body.end_date.trim() : startDate;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : '';
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return NextResponse.json({ error: 'A valid start and end date are required' }, { status: 400 });
  }

  const verdict = checkTimeOffWindow({
    startDate, endDate, todayISO: laTodayISO(), periodStartOf: payPeriodStartFor,
  });
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: timeOffRejectMessage(verdict.reason, verdict.earliestRequestable), code: verdict.reason.toUpperCase() },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_off_requests')
    .insert({
      user_id: employee.user_id,
      employee_id: employee.id,
      start_date: startDate,
      end_date: endDate,
      reason: reason || null,
      status: 'pending',
    })
    .select('id, start_date, end_date, reason, status, created_at')
    .single();

  if (error) {
    // The partial unique index (employee_id, start_date) WHERE status='pending' — a double-tapped
    // form, not an error worth alarming anyone about.
    if (error.code === '23505') {
      return NextResponse.json({ error: 'You already have a request open for that day.', code: 'DUPLICATE' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ request: data }, { status: 201 });
}

// DELETE { id } — withdraw one's OWN pending request. Scoped by employee_id so a token can never
// touch another worker's row, and limited to 'pending' so a decided request keeps its record.
export async function DELETE(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_off_requests')
    .update({ status: 'withdrawn' })
    .eq('id', id)
    .eq('employee_id', employee.id)
    .eq('user_id', employee.user_id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
