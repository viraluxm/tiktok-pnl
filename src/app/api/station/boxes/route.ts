import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { computePackReadyBoxes } from '@/lib/shipping/packReady';

export const dynamic = 'force-dynamic';

// GET /api/station/boxes — pack-ready box batch for the station, across ALL stores (no store_id
// filter). Same logic as /api/shipping/pick-tickets, scoped to the store owners' user_ids. Keeps
// the ?days age param. Service_role, gated on app_metadata.role === 'station'.
export async function GET(req: Request) {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;

  const daysParam = new URL(req.url).searchParams.get('days');
  try {
    const result = await computePackReadyBoxes(scope.admin, scope.ownerIds, { storeId: null, daysParam });
    return NextResponse.json(result);
  } catch (e) {
    console.error('[station/boxes]', e);
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}
