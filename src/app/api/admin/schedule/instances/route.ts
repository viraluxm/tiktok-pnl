import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { postOneTimeShift } from '@/lib/schedule/adminShifts';
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
