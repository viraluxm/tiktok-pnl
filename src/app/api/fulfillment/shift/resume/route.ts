import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST { shiftId } — on_break → working; closes the open break interval. RLS is_org_member.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { shiftId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const shiftId = typeof body.shiftId === 'string' ? body.shiftId : '';
  if (!shiftId) return NextResponse.json({ error: 'Missing shiftId' }, { status: 400 });

  const { data: shift } = await supabase.from('fulfillment_shifts').select('id, state').eq('id', shiftId).maybeSingle();
  if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
  if (shift.state !== 'on_break') return NextResponse.json({ error: 'NOT_ON_BREAK', state: shift.state }, { status: 409 });

  await supabase.from('fulfillment_shift_breaks').update({ ended_at: new Date().toISOString() }).eq('shift_id', shiftId).is('ended_at', null);
  await supabase.from('fulfillment_shifts').update({ state: 'working' }).eq('id', shiftId);
  return NextResponse.json({ ok: true, state: 'working' });
}
