import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { applyScheduleBatch, ScheduleBatchError } from '@/lib/schedule/bulkSchedule';
import { parseScheduleEntries } from '@/lib/schedule/schedulePlan';

export const dynamic = 'force-dynamic';

// POST /api/admin/schedule/instances/bulk — the ONE write path for planned shifts.
//
//   { entries: [{ employeeId, date, startTime, endTime } | { employeeId, date, off: true }, …],
//     dryRun?: boolean }
//
// Writes `shift_instances` only (never `shifts`). All-or-nothing at the planning level: if any day
// is refused the response is 409 with every refusal and NOTHING is written, so the manager fixes
// the day and saves again. Admin-gated with the same inline pattern as the sibling routes.
async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: { entries?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const parsed = parseScheduleEntries(body.entries);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const dryRun = body.dryRun === true;

  try {
    const result = await applyScheduleBatch({ userId: gate.user.id, entries: parsed.entries, dryRun });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Some days could not be saved.', refusals: result.refusals },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      dryRun: result.dryRun,
      ...result.counts,
      updatedDates: result.updatedDates,
      removedDates: result.removedDates,
    });
  } catch (e) {
    if (e instanceof ScheduleBatchError) {
      console.error('[schedule/bulk]', e.code, e.message);
      return NextResponse.json({ error: 'Could not save the schedule.', code: e.code }, { status: 500 });
    }
    console.error('[schedule/bulk] unexpected:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save the schedule.' }, { status: 500 });
  }
}
