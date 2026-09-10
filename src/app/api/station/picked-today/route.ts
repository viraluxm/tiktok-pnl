import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { pickedTodayTotals } from '@/lib/shipping/pickedToday';

export const dynamic = 'force-dynamic';

// GET /api/station/picked-today?picker=<employee_id>
//
// The day's verified-box count, read from shipment_verifications so it survives a reload.
// Scoped to one picker when `picker` is supplied — a picker's counter should show their own
// work, not the whole floor's.
export async function GET(req: Request) {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;

  const picker = new URL(req.url).searchParams.get('picker');
  const t = await pickedTodayTotals(scope.admin, scope.ownerIds, picker || null);
  // picked_today stays for compatibility — it is the RAW box count an older client expects. New
  // clients read `weighted`, which is the number the per-shift target is actually measured on.
  return NextResponse.json({ picked_today: t.boxes, ...t });
}
