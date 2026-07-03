import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST { shiftId, reason } — end a shift (manual | idle | break_timeout). Closes any open
// break, sets state='ended'. Idempotent-ish (already ended → ok). RLS is_org_member.
const REASONS = ['manual', 'idle', 'break_timeout'];

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { shiftId?: string; reason?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const shiftId = typeof body.shiftId === 'string' ? body.shiftId : '';
  const reason = REASONS.includes(body.reason ?? '') ? (body.reason as string) : 'manual';
  if (!shiftId) return NextResponse.json({ error: 'Missing shiftId' }, { status: 400 });

  const { data: shift } = await supabase.from('fulfillment_shifts').select('id, state').eq('id', shiftId).maybeSingle();
  if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
  if (shift.state === 'ended') return NextResponse.json({ ok: true, already_ended: true });

  const now = new Date().toISOString();
  await supabase.from('fulfillment_shift_breaks').update({ ended_at: now }).eq('shift_id', shiftId).is('ended_at', null);
  await supabase.from('fulfillment_shifts').update({ state: 'ended', ended_at: now, end_reason: reason }).eq('id', shiftId);
  return NextResponse.json({ ok: true, state: 'ended', end_reason: reason });
}
