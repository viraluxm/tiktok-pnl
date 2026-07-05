import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST { shiftId } — working → on_break; opens a break interval. RLS is_org_member.
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
  if (shift.state !== 'working') return NextResponse.json({ error: 'NOT_WORKING', state: shift.state }, { status: 409 });

  await supabase.from('fulfillment_shifts').update({ state: 'on_break' }).eq('id', shiftId);
  const { error } = await supabase.from('fulfillment_shift_breaks').insert({ shift_id: shiftId, started_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: 'Failed to open break', detail: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, state: 'on_break' });
}
