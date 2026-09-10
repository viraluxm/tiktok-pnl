import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { creditSinglesBatch } from '@/lib/shipping/creditSinglesBatch';

export const dynamic = 'force-dynamic';

// POST /api/shipping/singles-scan  { code, picker_employee_id }
// Owner-session variant. The station uses /api/station/singles-scan; both call the same
// creditSinglesBatch() so the two surfaces cannot drift on who is credited or what is excluded.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { code?: string; picker_employee_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const result = await creditSinglesBatch(
    createAdminClient(), user.id, String(body.code ?? ''), String(body.picker_employee_id ?? ''),
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json(result);
}
