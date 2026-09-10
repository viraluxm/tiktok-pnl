import { NextResponse } from 'next/server';
import { requireStationScope } from '@/lib/station/guard';
import { creditSinglesBatch } from '@/lib/shipping/creditSinglesBatch';

export const dynamic = 'force-dynamic';

// POST /api/station/singles-scan  { code, picker_employee_id }
//
// Credit a finished singles pile from the prep station. Service-role, scoped to the station's
// store owners — the station has no user session.
//
// CRITICAL, same rule as /api/station/confirm: the verification row's user_id must be the BOX
// OWNER's, never the station account. That id keys UNIQUE (user_id, group_key), so a row written
// under the station account would never dedupe against the operator flow and the same box could
// be credited twice. The owner is taken from the batch itself, then checked against the station's
// scope — a code belonging to another owner resolves to nothing rather than crediting across
// accounts.
export async function POST(req: Request) {
  const scope = await requireStationScope();
  if (!scope.ok) return scope.response;
  const { admin, ownerIds } = scope;

  let body: { code?: string; picker_employee_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const code = String(body.code ?? '').trim().toUpperCase();

  // Resolve the owner FROM the batch, constrained to this station's scope.
  const { data: batchRow } = await admin
    .from('singles_batches')
    .select('user_id')
    .eq('code', code)
    .in('user_id', ownerIds)
    .maybeSingle();
  const ownerId = (batchRow?.user_id as string | null) ?? null;
  if (!ownerId) return NextResponse.json({ error: 'Unknown batch barcode.' }, { status: 404 });

  const result = await creditSinglesBatch(admin, ownerId, code, String(body.picker_employee_id ?? ''));
  if (!result.ok) {
    return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json(result);
}
