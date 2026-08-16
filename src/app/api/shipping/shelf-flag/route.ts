import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clearShelfFlags, reportShelfOut, resolveFlagPicker } from '@/lib/shipping/shelfFlags';

export const dynamic = 'force-dynamic';

// POST /api/shipping/shelf-flag — the operator-side "Can't find it" / "Found it" toggle from the
// pick card. Scoped to the caller's own user_id (the station equivalent is
// /api/station/shelf-flag, which resolves the owner instead).
//
// Body: { inventory_sku_id, action: 'report' | 'clear', picker_employee_id? }
//
// DISPLAY-ONLY SEMANTICS: this writes nothing that gates picking. It never touches
// inventory_skus.qty_on_hand, never touches the capture or order-sync path, and a failure here
// costs a band on a card — not a pick. Explicit 'clear' is the SECONDARY undo path; the primary
// clear is 'grabbed', written by /api/shipping/confirm for every SKU actually picked.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { inventory_sku_id?: unknown; action?: unknown; picker_employee_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const skuId = typeof body.inventory_sku_id === 'string' ? body.inventory_sku_id.trim() : '';
  if (!skuId) return NextResponse.json({ error: 'Missing inventory_sku_id' }, { status: 400 });
  const action = body.action === 'clear' ? 'clear' : body.action === 'report' ? 'report' : null;
  if (!action) return NextResponse.json({ error: "action must be 'report' or 'clear'" }, { status: 400 });

  // The SKU must belong to the caller — a flag on someone else's catalog row is never valid.
  const { data: sku } = await supabase
    .from('inventory_skus')
    .select('id')
    .eq('user_id', user.id)
    .eq('id', skuId)
    .maybeSingle();
  if (!sku) return NextResponse.json({ error: 'Unknown SKU' }, { status: 404 });

  const rawPicker = typeof body.picker_employee_id === 'string' ? body.picker_employee_id.trim() : '';
  const picker = await resolveFlagPicker(supabase, user.id, rawPicker, 'shipping/shelf-flag');

  const res = action === 'report'
    ? await reportShelfOut(supabase, {
        ownerUserId: user.id, skuId, employeeId: picker.employeeId, employeeName: picker.employeeName,
      })
    : await clearShelfFlags(supabase, {
        ownerUserId: user.id, skuIds: [skuId], employeeId: picker.employeeId, reason: 'undo',
      });

  if (!res.ok) {
    console.error('[shipping/shelf-flag] write error:', res.error);
    return NextResponse.json({ error: 'Failed to save shelf flag' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, inventory_sku_id: skuId, shelf_out: action === 'report' });
}
