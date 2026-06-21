import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const RESULTS = new Set(['sold', 'not_sold']);
type Line = { sku_id: string; qty: number };

// Map a raised RPC error (by message token) to a clean HTTP response. No secrets/PII.
function mapRpcError(message: string): { status: number; error: string } {
  const m = message || '';
  if (m.includes('NOT_AUTHENTICATED')) return { status: 401, error: 'Unauthorized' };
  if (m.includes('OUT_OF_STOCK')) {
    const n = m.split('OUT_OF_STOCK:')[1]?.trim();
    return { status: 409, error: n ? `SKU ${n} is out of stock` : 'Out of stock' };
  }
  if (m.includes('SESSION_ENDED')) return { status: 409, error: 'This session has ended' };
  if (m.includes('SESSION_NOT_FOUND')) return { status: 404, error: 'Session not found' };
  if (m.includes('SKU_NOT_FOUND')) return { status: 400, error: 'One or more SKUs not found' };
  if (m.includes('INVALID_RESULT')) return { status: 400, error: 'Invalid result' };
  if (m.includes('NO_SKUS')) return { status: 400, error: 'Select at least one SKU' };
  return { status: 500, error: 'Failed to log auction' };
}

// POST: log one auction (sold / not_sold) via the atomic RPC.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { result?: string; skus?: Line[]; client_idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 });
  }

  const result = typeof body.result === 'string' && RESULTS.has(body.result) ? body.result : null;
  if (!result) return NextResponse.json({ error: 'Invalid result' }, { status: 400 });

  const idemKey =
    typeof body.client_idempotency_key === 'string' && body.client_idempotency_key.trim()
      ? body.client_idempotency_key.trim()
      : null;

  // Collapse duplicate SKUs into one line each with summed qty.
  const byId = new Map<string, number>();
  for (const l of body.skus ?? []) {
    if (!l || typeof l.sku_id !== 'string') continue;
    const qty = Math.max(1, Math.trunc(Number(l.qty) || 1));
    byId.set(l.sku_id, (byId.get(l.sku_id) ?? 0) + qty);
  }
  const lines: Line[] = [...byId.entries()].map(([sku_id, qty]) => ({ sku_id, qty }));
  if (lines.length === 0) return NextResponse.json({ error: 'Select at least one SKU' }, { status: 400 });

  const { data, error } = await supabase.rpc('lensed_log_auction', {
    p_session_id: sessionId,
    p_result: result,
    p_skus: lines,
    p_idem_key: idemKey,
  });

  if (error) {
    const mapped = mapRpcError(error.message ?? '');
    console.error('[live/quick-close] rpc error:', error.code, error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return NextResponse.json({ error: 'Failed to log auction' }, { status: 500 });

  return NextResponse.json(
    {
      ok: true,
      replayed: row.replayed,
      id: row.item_id,
      auction_number: row.auction_number,
      status: row.status,
      total_cost_cents: row.total_cost_cents,
      expected_price_cents: row.expected_price_cents,
    },
    { status: row.replayed ? 200 : 201 },
  );
}
