import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// POST: settle a NEGATIVE cost layer — add exactly its deficit to reach 0 and
// bump qty_on_hand to match. Quantity-only: wraps lensed_settle_batch, which
// never touches any recorded sale cost (those were locked at bind). Ownership is
// enforced inside the RPC via auth.uid() + per-user RLS.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const { batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase.rpc('lensed_settle_batch', { p_batch_id: batchId });
  if (error) {
    if ((error.message || '').includes('BATCH_NOT_FOUND')) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    console.error('[inventory/batches] settle error:', error.code, error.message);
    return NextResponse.json({ error: 'Failed to settle batch' }, { status: 500 });
  }
  // data = units added (0 if the batch was not negative).
  return NextResponse.json({ ok: true, units_added: data ?? 0 });
}
