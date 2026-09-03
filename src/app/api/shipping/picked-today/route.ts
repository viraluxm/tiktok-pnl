import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { countBoxesPickedToday } from '@/lib/shipping/pickedToday';

export const dynamic = 'force-dynamic';

// GET /api/shipping/picked-today?picker=<employee_id>
//
// Owner-side twin of /api/station/picked-today. The day's verified-box count read from
// shipment_verifications, so the pack overlay's counter survives a reload instead of restarting
// from zero.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const picker = new URL(req.url).searchParams.get('picker');
  const count = await countBoxesPickedToday(supabase, [user.id], picker || null);
  return NextResponse.json({ picked_today: count });
}
