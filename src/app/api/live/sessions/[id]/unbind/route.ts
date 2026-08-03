import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST: reverse a retroactive bind — the correction path for a wrong-SKU bind. Delegates to the
// lensed_unbind RPC (restocks qty at the snapshot cost as a fresh FIFO layer + deletes the
// live_auction_items / _skus rows). Idempotent. Does NOT touch lensed_log_auction. To CHANGE a
// SKU: unbind, then bind again via /bind.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { order_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  if (!orderId) return NextResponse.json({ error: 'order_id required' }, { status: 400 });

  // Ownership: the session must belong to the caller (mirrors /bind). The RPC is keyed on
  // (user_id, order_id), so it corrects the caller's own bound item.
  const { data: session } = await supabase
    .from('live_sessions').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const { data, error } = await supabase.rpc('lensed_unbind', { p_order_id: orderId });
  if (error) {
    // Surface the real reason (internal tool) — a generic "Failed to unbind" hid a multi-SKU
    // constraint 500 for days. Callers render this message.
    console.error('[live/unbind] rpc error:', error.code, error.message);
    return NextResponse.json({ error: `Unbind failed: ${error.message}`, code: error.code }, { status: 500 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    unbound: row?.unbound ?? false,
    restocked_lines: row?.restocked_lines ?? 0,
    restocked_units: row?.restocked_units ?? 0,
  });
}
