import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { resolveAndUpsertBox } from '@/lib/fulfillment/box';

export const dynamic = 'force-dynamic';

// POST { orderId } — picker scans a packing slip to load (or create, status 'picking')
// the box. Non-destructive: re-scanning resumes without wiping pick progress.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { orderId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return NextResponse.json({ error: 'Scan a packing slip order ID' }, { status: 400 });

  const out = await resolveAndUpsertBox(supabase, user.id, orgId, orderId, 'picking');
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out.box);
}
