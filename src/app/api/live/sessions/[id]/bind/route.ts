import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST: retroactive manual bind — attach a chosen inventory SKU to an unbound
// captured order. Reuses lensed_log_auction → exactly-once decrement + cost
// snapshot + OUT_OF_STOCK guard + idempotency on order_id.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { order_id?: string; lines?: { sku_id?: string; qty?: number }[]; allow_negative?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  // Only an explicit, user-CONFIRMED bind sets this — it lets the decrement go
  // negative (a real sale against an under-counted/forgotten SKU). The default
  // path leaves it false → the RPC still raises OUT_OF_STOCK.
  const allowNegative = body.allow_negative === true;
  // Collapse multiple lines for the same SKU into one (sum qty) — matches the
  // collapsed p_skus the live-capture path sends; each distinct SKU = one line.
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const byId = new Map<string, number>();
  for (const l of rawLines) {
    const sid = typeof l?.sku_id === 'string' ? l.sku_id.trim() : '';
    if (!sid) continue;
    byId.set(sid, (byId.get(sid) ?? 0) + Math.max(1, Math.trunc(Number(l?.qty) || 1)));
  }
  const pSkus = [...byId.entries()].map(([sku_id, qty]) => ({ sku_id, qty }));
  if (!orderId || pSkus.length === 0) return NextResponse.json({ error: 'order_id and at least one SKU line required' }, { status: 400 });

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, status')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // ── DOUBLE-BIND GUARD (two layers) ──
  // (1) Friendly pre-check: if an auction item already exists for this order in
  //     this session, do NOT create a second — return the existing state.
  const { data: existing } = await supabase
    .from('live_auction_items')
    .select('id, status')
    .eq('user_id', user.id).eq('session_id', id)
    .eq('client_idempotency_key', orderId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, already_bound: true, status: existing.status });

  // Retroactive bind is post-show: permit it on an ended/reconciled session via
  // p_manual=true (the RPC bypasses ONLY the session-ended check for manual binds;
  // the extension's live auto-bind never sets this, so it stays blocked).
  const manual = session.status === 'ended' || session.status === 'reconciled';

  // (2) Authoritative guard: lensed_log_auction is idempotent on (session, order_id).
  //     Even under a race, a second call replays — no duplicate row, no second decrement.
  const { data, error } = await supabase.rpc('lensed_log_auction', {
    p_session_id: id, p_result: 'sold', p_skus: pSkus, p_idem_key: orderId, p_manual: manual,
    p_allow_negative: allowNegative,
  });
  if (error) {
    const msg = error.message || '';
    if (msg.includes('OUT_OF_STOCK')) return NextResponse.json({ error: 'Out of stock for that SKU' }, { status: 409 });
    if (msg.includes('SESSION_ENDED')) return NextResponse.json({ error: 'Session ended — manual bind not permitted' }, { status: 409 });
    if (msg.includes('SKU_NOT_FOUND')) return NextResponse.json({ error: 'SKU not found' }, { status: 400 });
    console.error('[live/bind] rpc error:', error.code, error.message);
    return NextResponse.json({ error: 'Failed to bind' }, { status: 500 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ ok: true, replayed: row?.replayed ?? false, status: row?.status });
}
