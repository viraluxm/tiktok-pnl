import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { guardPublicWrite } from '@/lib/schedule/publicRoute';
import { createAdminClient } from '@/lib/supabase/admin';
import { clockCodeLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /s/[token]/clock  { shift_instance_id, purpose }  — public schedule-link session (no auth
// session; under /s/ so it bypasses middleware, like release/claim). Issues a single-use rotating
// nonce for the station scanner. All validation is server-side against now() — never a client clock.
// Rotation = upsert on the PK (employee_id, shift_instance_id, purpose): the previous code dies.
const PURPOSES = new Set(['clock_in', 'clock_out', 'break_start', 'break_end']);

async function auditIssue(admin: ReturnType<typeof createAdminClient>, row: {
  user_id?: string | null; employee_id: string; shift_instance_id: string; purpose: string; outcome: string; reason?: string;
}) {
  const { error } = await admin.from('clock_audit').insert({ event: 'issue', ...row });
  if (error) console.error('[clock/issue] audit insert failed:', error.message);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublicWrite(token, req);
  if ('response' in guard) return guard.response;
  const { employee } = guard.resolved;

  // Stuck-client throttle: ~4 issues / 30s per employee (on top of guardPublicWrite's token/IP caps).
  if (!clockCodeLimiter.check(`clock-issue:${employee.id}`).success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: { shift_instance_id?: unknown; purpose?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const shiftInstanceId = typeof body.shift_instance_id === 'string' ? body.shift_instance_id.trim() : '';
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
  if (!shiftInstanceId || !PURPOSES.has(purpose)) {
    return NextResponse.json({ error: 'shift_instance_id and a valid purpose are required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const ownerId = String(employee.user_id);

  // 1. employee active.
  if (employee.status !== 'active') {
    await auditIssue(admin, { user_id: ownerId, employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, outcome: 'rejected', reason: 'inactive_employee' });
    return NextResponse.json({ error: 'Not available' }, { status: 403 });
  }

  // 2. shift belongs to this worker and is not released; 3. now() within [start-45m, end+60m].
  const { data: si, error: siErr } = await admin
    .from('shift_instances')
    .select('id, starts_at, ends_at, released_at')
    .eq('id', shiftInstanceId)
    .eq('employee_id', employee.id)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (siErr) return NextResponse.json({ error: siErr.message }, { status: 500 });
  if (!si || si.released_at) {
    await auditIssue(admin, { user_id: ownerId, employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, outcome: 'rejected', reason: si ? 'released' : 'not_your_shift' });
    return NextResponse.json({ error: 'Not your shift' }, { status: 403 });
  }
  const now = Date.now();
  const startMs = new Date(si.starts_at as string).getTime();
  const endMs = new Date(si.ends_at as string).getTime();
  if (now < startMs - 45 * 60_000 || now > endMs + 60 * 60_000) {
    await auditIssue(admin, { user_id: ownerId, employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, outcome: 'rejected', reason: 'out_of_window' });
    return NextResponse.json({ error: 'Outside your shift window' }, { status: 409 });
  }

  // 4. purpose legal for the CURRENT attendance state (from employee_time_entries), server-derived.
  const { data: openEntry } = await admin
    .from('employee_time_entries')
    .select('id')
    .eq('employee_id', employee.id)
    .eq('user_id', ownerId)
    .is('clocked_out_at', null)
    .maybeSingle();
  let onBreak = false;
  if (openEntry) {
    const { data: br } = await admin
      .from('employee_time_breaks')
      .select('id')
      .eq('time_entry_id', openEntry.id)
      .is('ended_at', null)
      .maybeSingle();
    onBreak = !!br;
  }
  const state = !openEntry ? 'clocked_out' : onBreak ? 'on_break' : 'working';
  const legal =
    (purpose === 'clock_in' && state === 'clocked_out') ||
    (purpose === 'clock_out' && state === 'working') ||
    (purpose === 'break_start' && state === 'working') ||
    (purpose === 'break_end' && state === 'on_break');
  if (!legal) {
    await auditIssue(admin, { user_id: ownerId, employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, outcome: 'rejected', reason: `illegal_for_${state}` });
    return NextResponse.json({ error: 'That action is not available right now' }, { status: 409 });
  }

  // Issue: rotate the code (upsert on PK; user_id is set by the trigger, never by us).
  const code = 'LNS1' + randomBytes(16).toString('base64url');
  const expiresAt = new Date(now + 45_000).toISOString();
  const { error: upErr } = await admin
    .from('clock_codes')
    .upsert(
      { employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, code, expires_at: expiresAt, consumed_at: null, consumed_station_id: null },
      { onConflict: 'employee_id,shift_instance_id,purpose' },
    );
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  await auditIssue(admin, { user_id: ownerId, employee_id: employee.id, shift_instance_id: shiftInstanceId, purpose, outcome: 'ok' });
  return NextResponse.json({ code, expires_at: expiresAt });
}
