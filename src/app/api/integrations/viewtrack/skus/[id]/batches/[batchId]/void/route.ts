import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertViewTrackAuth, IntegrationError } from '@/lib/integrations/viewtrack-auth';

export const dynamic = 'force-dynamic';

// Void (undo) a single ViewTrack-created batch layer. Removes ONLY that layer and
// restores qty_on_hand in lockstep — refuses if any of it has been drawn by a
// sale (ALREADY_DRAWN). Deleting the layer clears its idempotency record, so the
// same order can be re-sent fresh. Shared-secret + service-role; org from secret.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  const { batchId } = await params;

  let ctx;
  try {
    ctx = assertViewTrackAuth(_req);
  } catch (e) {
    if (e instanceof IntegrationError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('lensed_void_batch', {
    p_org_id: ctx.orgId,
    p_batch_id: batchId,
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('ALREADY_DRAWN')) {
      return NextResponse.json(
        { error: 'This batch has already been drawn from by a sale and cannot be voided.' },
        { status: 409 },
      );
    }
    if (msg.includes('BATCH_NOT_FOUND')) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    console.error('[integrations/viewtrack/void] error:', error.code, msg);
    return NextResponse.json({ error: 'Failed to void batch' }, { status: 500 });
  }

  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    batch_id: row?.batch_id ?? batchId,
    sku_id: row?.sku_id ?? null,
    qty_on_hand: row?.qty_on_hand ?? null,
    voided_qty: row?.voided_qty ?? null,
  });
}
