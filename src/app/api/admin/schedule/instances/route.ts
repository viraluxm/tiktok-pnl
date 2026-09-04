import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { postOneTimeShift, removeOneTimeShift } from '@/lib/schedule/adminShifts';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// One-time admin shift → shift_instances (migration 090). NON-PAYABLE (shift_instances never feed
// pay — that's `shifts`). Assigned → the person's /s; unassigned → the board. Admin-gated, same
// inline pattern as the token route.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

// POST { date, startTime, endTime, role?, employeeId?, note? }
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const date = String(body.date ?? '');
  const startTime = String(body.startTime ?? '');
  const endTime = String(body.endTime ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'Missing/invalid date' }, { status: 400 });
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return NextResponse.json({ error: 'Missing/invalid start or end time' }, { status: 400 });
  }
  const employeeId = body.employeeId ? String(body.employeeId) : null;
  const role = body.role ? String(body.role) : null;
  const note = body.note ? String(body.note).slice(0, 500) : null;

  try {
    const { id } = await postOneTimeShift({ userId: gate.user.id, date, startTime, endTime, role, employeeId, note });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    if (e instanceof ScheduleError) {
      const status = e.code === 'ROLE_REQUIRED' || e.code === 'BAD_TIMES' ? 400 : e.code === 'EMPLOYEE_NOT_FOUND' ? 404 : 500;
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// DELETE { id } → remove ONE one-time admin shift. Body-carrying DELETE matches the sibling
// admin/schedule/tokens route. Same requireAdmin() gate as POST above — no new auth mechanism.
//
// Only an UNTOUCHED FUTURE 'admin_open' + 'scheduled' instance is removable; every other case is a
// 409 with a manager-readable reason. Recurring ('pattern') instances are refused outright: the
// forward materializer would regenerate them. See removeOneTimeShift / planShiftRemoval.
const REMOVAL_CONFLICTS = new Set([
  'NOT_ONE_OFF',
  'NOT_SCHEDULED',
  'ALREADY_STARTED',
  'WORKED_TIME_EXISTS',
  'EMPLOYEE_CLOCKED_IN',
  'SHIFT_UNAVAILABLE',
]);

export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let id: string;
  try {
    id = String((await req.json()).id ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    await removeOneTimeShift({ userId: gate.user.id, instanceId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ScheduleError) {
      const status = e.code === 'NOT_FOUND' ? 404 : REMOVAL_CONFLICTS.has(e.code) ? 409 : 500;
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
