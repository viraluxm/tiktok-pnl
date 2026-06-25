import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// Focused toggle for the active/inactive state.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }
  if (typeof body.is_active !== 'boolean') {
    return NextResponse.json({ error: 'is_active (boolean) required' }, { status: 400 });
  }

  // SHARED inventory: any org member can toggle the shared SKU.
  const orgId = await getOrgId(supabase, user.id);
  const { data, error } = await supabase
    .from('inventory_skus')
    .update({ is_active: body.is_active })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id, is_active')
    .maybeSingle();

  if (error) {
    console.error('[inventory/skus/active] error:', error);
    return NextResponse.json({ error: 'Failed to update SKU' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
  return NextResponse.json({ sku: data });
}
