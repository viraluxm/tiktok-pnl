import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Map a raised RPC error (by message token) to a clean HTTP response. No secrets/PII.
function mapRpcError(message: string): { status: number; error: string } {
  const m = message || '';
  if (m.includes('NOT_AUTHENTICATED')) return { status: 401, error: 'Unauthorized' };
  if (m.includes('SESSION_ENDED')) return { status: 409, error: 'This session has ended' };
  if (m.includes('SESSION_NOT_FOUND')) return { status: 404, error: 'Session not found' };
  if (m.includes('ITEM_NOT_FOUND')) return { status: 404, error: 'Auction row not found' };
  return { status: 500, error: 'Failed to delete auction row' };
}

// DELETE an auction row via the atomic RPC (restores inventory for sold rows).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id: sessionId, itemId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase.rpc('lensed_delete_auction_item', {
    p_session_id: sessionId,
    p_item_id: itemId,
  });

  if (error) {
    const mapped = mapRpcError(error.message ?? '');
    console.error('[live/items] rpc error:', error.code, error.message);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }

  return NextResponse.json({ ok: true, restored: data === true });
}
