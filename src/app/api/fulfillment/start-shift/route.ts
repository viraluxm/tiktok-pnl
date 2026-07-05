import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// POST { deviceId, workerId } — start a shift (under the device's fulfillment session).
// Server-side ELIGIBILITY (the enforcement deferred from chunk 5): worker must be org +
// active + role matching the device's kind (picker→picker/both, packer→packer/both), else
// 403 INELIGIBLE. mode = device.kind (never client-chosen). Closes any prior open shift for
// the device first (≤1 active shift per device). RLS is_org_member (chunk 4) authorizes.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { deviceId?: string; workerId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const workerId = typeof body.workerId === 'string' ? body.workerId : '';
  if (!deviceId || !workerId) return NextResponse.json({ error: 'Missing deviceId or workerId' }, { status: 400 });

  const { data: device } = await supabase
    .from('fulfillment_devices').select('id, kind, is_active').eq('id', deviceId).eq('org_id', orgId).maybeSingle();
  if (!device || !device.is_active) return NextResponse.json({ error: 'DEVICE_INVALID', message: 'Device not found or revoked' }, { status: 400 });

  const { data: worker } = await supabase
    .from('fulfillment_workers').select('id, role, is_active').eq('id', workerId).eq('org_id', orgId).maybeSingle();
  if (!worker || !worker.is_active) return NextResponse.json({ error: 'WORKER_INVALID', message: 'Worker not found or inactive' }, { status: 400 });

  const eligible = device.kind === 'picker' ? (worker.role === 'picker' || worker.role === 'both')
                                            : (worker.role === 'packer' || worker.role === 'both');
  if (!eligible) return NextResponse.json({ error: 'INELIGIBLE', message: `This worker isn't eligible for a ${device.kind} device` }, { status: 403 });

  // Close any prior open shift for this device (safety → ≤1 active per device).
  const now = new Date().toISOString();
  const { data: openShifts } = await supabase
    .from('fulfillment_shifts').select('id').eq('device_id', deviceId).in('state', ['working', 'on_break']);
  const ids = (openShifts ?? []).map((s) => s.id);
  if (ids.length) {
    await supabase.from('fulfillment_shift_breaks').update({ ended_at: now }).in('shift_id', ids).is('ended_at', null);
    await supabase.from('fulfillment_shifts').update({ state: 'ended', ended_at: now, end_reason: 'manual' }).in('id', ids);
  }

  const { data: shift, error } = await supabase
    .from('fulfillment_shifts')
    .insert({ org_id: orgId, worker_id: workerId, device_id: deviceId, mode: device.kind, state: 'working', started_at: now })
    .select('id, mode, worker_id, state').single();
  if (error || !shift) return NextResponse.json({ error: 'Failed to start shift', detail: error?.message }, { status: 500 });

  return NextResponse.json({ shift_id: shift.id, mode: shift.mode, worker_id: shift.worker_id, state: shift.state });
}
