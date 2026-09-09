import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listPickupRequests, approvePickup, declinePickup } from '@/lib/schedule/adminShifts';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// Phase 2 manager queue: pending SHIFT PICKUP REQUESTS + approve/decline.
//
// Kept separate from /api/admin/schedule/claims (the legacy OT queue) because the two have
// different vocabularies and different write paths — approve here is a transactional RPC, not a
// pair of PostgREST updates. Same inline admin gate as its siblings, and every helper below is
// owner-scoped with the session uid (the #217 discipline: never a client-supplied owner).

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
    return NextResponse.json({ ok: true, requests: await listPickupRequests(gate.user.id) });
  } catch (e) {
    console.error('[schedule/pickups] list:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load pickup requests.' }, { status: 500 });
  }
}

// POST { claimId, shiftInstanceId, offerId, action: 'approve' | 'decline' }
//
// The identifiers are echoed back by the queue the manager is looking at; the RPC re-checks that
// they still agree with the row state, so a stale queue refuses rather than transferring the wrong
// shift. Ownership is NOT taken from the body — it is the session uid.
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const claimId = String(body.claimId ?? '');
  const action = String(body.action ?? '');
  if (!claimId) return NextResponse.json({ error: 'Missing claimId' }, { status: 400 });
  if (action !== 'approve' && action !== 'decline') {
    return NextResponse.json({ error: "action must be 'approve' or 'decline'" }, { status: 400 });
  }

  try {
    if (action === 'decline') {
      await declinePickup({ ownerId: gate.user.id, claimId });
      return NextResponse.json({ ok: true, action: 'declined' });
    }
    const shiftInstanceId = String(body.shiftInstanceId ?? '');
    const offerId = String(body.offerId ?? '');
    if (!shiftInstanceId || !offerId) {
      return NextResponse.json({ error: 'Missing shiftInstanceId or offerId' }, { status: 400 });
    }
    const result = await approvePickup({ ownerId: gate.user.id, claimId, shiftInstanceId, offerId });
    return NextResponse.json({ ok: true, action: 'approved', ...result });
  } catch (e) {
    if (e instanceof ScheduleError) {
      // Every refusal the RPC can return is a manager-readable sentence; 409 = "the world moved".
      const status = e.code === 'CLAIM_NOT_FOUND' || e.code === 'SHIFT_NOT_FOUND' ? 404
        : e.code === 'APPROVE_FAILED' || e.code === 'DECLINE_FAILED' || e.code === 'READ_FAILED' ? 500
        : 409;
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    console.error('[schedule/pickups]', (e as Error).message);
    return NextResponse.json({ error: 'Could not update this request.' }, { status: 500 });
  }
}
