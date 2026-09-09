import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listPendingTrades, approveTrade, declineTrade } from '@/lib/schedule/trade';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// Manager queue for SHIFT TRADES the coworker has already accepted: list + approve/decline.
//
// Same inline admin gate and the same owner discipline as /api/admin/schedule/pickups: the owner
// is the session uid, never a client-supplied id, and approve is ONE transactional RPC
// (lensed_approve_shift_trade) that re-validates both shifts before swapping them.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  try {
    return NextResponse.json({ ok: true, trades: await listPendingTrades(gate.user.id) });
  } catch (e) {
    console.error('[schedule/trades] list:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load trade requests.' }, { status: 500 });
  }
}

// POST { tradeId, action: 'approve' | 'decline', note? }
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const tradeId = String(body.tradeId ?? '');
  const action = String(body.action ?? '');
  if (!tradeId) return NextResponse.json({ error: 'Missing tradeId' }, { status: 400 });
  if (action !== 'approve' && action !== 'decline') {
    return NextResponse.json({ error: "action must be 'approve' or 'decline'" }, { status: 400 });
  }

  try {
    if (action === 'decline') {
      await declineTrade({ ownerId: gate.user.id, tradeId, note: typeof body.note === 'string' ? body.note : null });
      return NextResponse.json({ ok: true, action: 'declined' });
    }
    const result = await approveTrade({ ownerId: gate.user.id, tradeId });
    return NextResponse.json({ ok: true, action: 'approved', ...result });
  } catch (e) {
    if (e instanceof ScheduleError) {
      const status = e.code === 'TRADE_NOT_FOUND' || e.code === 'SHIFT_NOT_FOUND' ? 404
        : e.code === 'APPROVE_FAILED' || e.code === 'DECLINE_FAILED' || e.code === 'READ_FAILED' ? 500
        : 409;
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    console.error('[schedule/trades]', (e as Error).message);
    return NextResponse.json({ error: 'Could not update this trade.' }, { status: 500 });
  }
}
