import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Manager queue for time-off requests. Runs on the CALLER's own session — RLS (own-row on
// user_id) is the scope here, unlike the public /s/* routes which must use service-role.

// GET ?status=pending — the queue. Defaults to everything still actionable or upcoming.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const status = new URL(req.url).searchParams.get('status');

  let q = supabase
    .from('time_off_requests')
    .select('id, employee_id, start_date, end_date, reason, status, decision_note, decided_at, created_at')
    .neq('status', 'withdrawn')
    .order('start_date', { ascending: true });
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) {
    console.error('[admin/time-off] read failed:', error.message);
    return NextResponse.json({ error: 'Failed to load time-off requests' }, { status: 500 });
  }
  const requests = data ?? [];

  // CONFLICTS. Approving time off never deletes or reassigns a shift (see PATCH). So a manager
  // approving a request that overlaps an already-planned shift must be TOLD, and then handle the
  // schedule with the normal tools. Count active planned shifts (scheduled/claimed shift_instances)
  // per request over the request's own days. Same session client, same RLS scope.
  const pending = requests.filter((r) => r.status === 'pending');
  const conflicts = new Map<string, number>();
  if (pending.length > 0) {
    const from = pending.reduce((m, r) => (r.start_date < m ? r.start_date : m), pending[0].start_date);
    const to = pending.reduce((m, r) => (r.end_date > m ? r.end_date : m), pending[0].end_date);
    const { data: inst } = await supabase
      .from('shift_instances')
      .select('employee_id, shift_date')
      .in('employee_id', [...new Set(pending.map((r) => r.employee_id))])
      .in('status', ['scheduled', 'claimed'])
      .gte('shift_date', from)
      .lte('shift_date', to);
    for (const r of pending) {
      const n = (inst ?? []).filter((i) => i.employee_id === r.employee_id && i.shift_date >= r.start_date && i.shift_date <= r.end_date).length;
      conflicts.set(r.id, n);
    }
  }
  return NextResponse.json({ requests: requests.map((r) => ({ ...r, conflicts: conflicts.get(r.id) ?? 0 })) });
}

// PATCH { id, status: 'approved'|'denied', note? } — decide one request.
//
// Deciding does NOT touch shift_instances. Approving records the decision; it never deletes a
// shift that already exists (that is a release, a different action with different bookkeeping).
// Its purpose is to be visible in the calendar BEFORE the period is built.
const DECISIONS = new Set(['approved', 'denied']);

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; status?: unknown; note?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  if (!id || !DECISIONS.has(status)) {
    return NextResponse.json({ error: 'id and a valid status are required' }, { status: 400 });
  }

  // RLS confines this to the caller's own rows; the explicit id is the only other filter needed.
  const { data, error } = await supabase
    .from('time_off_requests')
    .update({
      status,
      decision_note: note || null,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();
  if (error) {
    console.error('[admin/time-off] decide failed:', error.message);
    return NextResponse.json({ error: 'Failed to save that decision' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ request: data });
}
