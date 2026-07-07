import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST: mark a box (combine group, or singleton order) picked/verified.
// The single write the pick-verify flow makes. Idempotent on (user, group_key).
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { group_key?: string; order_ids?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const groupKey = typeof body.group_key === 'string' ? body.group_key.trim() : '';
  if (!groupKey) return NextResponse.json({ error: 'Missing group_key' }, { status: 400 });
  const orderIds = Array.isArray(body.order_ids)
    ? body.order_ids.filter((x): x is string => typeof x === 'string')
    : [];

  // Derive store from the orders in this box (fulfillment context, not a session).
  // Orders in a box share a store; take the first synced order's store_id. Null →
  // the set_store_id trigger backstops it (e.g. orders not yet synced).
  let storeId: string | null = null;
  if (orderIds.length) {
    const { data: ord } = await supabase
      .from('synced_order_ids')
      .select('store_id')
      .in('order_id', orderIds)
      .not('store_id', 'is', null)
      .limit(1)
      .maybeSingle();
    storeId = (ord?.store_id as string | null) ?? null;
  }

  const row: Record<string, unknown> = {
    user_id: user.id, group_key: groupKey, order_ids: orderIds, verified_at: new Date().toISOString(),
  };
  if (storeId) row.store_id = storeId; // explicit when derivable; else trigger backstops

  const { error } = await supabase
    .from('shipment_verifications')
    .upsert(row, { onConflict: 'user_id,group_key' });

  if (error) {
    console.error('[shipping/confirm] upsert error:', error);
    return NextResponse.json({ error: 'Failed to save verification' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, group_key: groupKey });
}
