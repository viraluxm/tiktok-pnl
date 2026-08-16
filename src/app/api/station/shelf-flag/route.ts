import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { clearShelfFlags, reportShelfOut, resolveFlagPicker } from '@/lib/shipping/shelfFlags';

export const dynamic = 'force-dynamic';

// POST /api/station/shelf-flag — the station-side "Can't find it" / "Found it" toggle.
//
// THE STATION'S FIRST WRITE. /api/station/scan was read-only by design; this route is the
// deliberate exception, and its blast radius is bounded to one additive table: it writes ONLY
// sku_shelf_flags, never inventory_skus, capture_events, or anything on the order-sync path.
// The read-only note in station/scan/route.ts has been amended to say so.
//
// Service-role + owner-scoped like every /api/station/* route: the station account owns no
// inventory, so the flag's user_id MUST be the SKU OWNER's — otherwise the operator flow
// (/api/shipping/*, which reads by its own user_id) would never see the station's flags.
export async function POST(req: Request) {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  let body: { inventory_sku_id?: unknown; action?: unknown; picker_employee_id?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const skuId = typeof body.inventory_sku_id === 'string' ? body.inventory_sku_id.trim() : '';
  if (!skuId) return NextResponse.json({ error: 'Missing inventory_sku_id' }, { status: 400 });
  const action = body.action === 'clear' ? 'clear' : body.action === 'report' ? 'report' : null;
  if (!action) return NextResponse.json({ error: "action must be 'report' or 'clear'" }, { status: 400 });

  // Resolve the SKU's OWNER, constrained to the station's scope. Doubles as the existence check:
  // a SKU outside the owner set is indistinguishable from a nonexistent one, by design.
  const { data: sku } = await admin
    .from('inventory_skus')
    .select('user_id')
    .eq('id', skuId)
    .in('user_id', ownerIds)
    .maybeSingle();
  const ownerUserId = (sku?.user_id as string | null) ?? null;
  if (!ownerUserId) return NextResponse.json({ error: 'Unknown SKU' }, { status: 404 });

  const rawPicker = typeof body.picker_employee_id === 'string' ? body.picker_employee_id.trim() : '';
  const picker = await resolveFlagPicker(admin, ownerUserId, rawPicker, 'station/shelf-flag');

  const res = action === 'report'
    ? await reportShelfOut(admin, {
        ownerUserId, skuId, employeeId: picker.employeeId, employeeName: picker.employeeName,
      })
    : await clearShelfFlags(admin, {
        ownerUserId, skuIds: [skuId], employeeId: picker.employeeId, reason: 'undo',
      });

  if (!res.ok) {
    console.error('[station/shelf-flag] write error:', res.error);
    return NextResponse.json({ error: 'Failed to save shelf flag' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, inventory_sku_id: skuId, shelf_out: action === 'report' });
}
