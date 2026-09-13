import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { approveShiftRequest, declineShiftRequest, listShiftRequests } from '@/lib/schedule/capacityAdmin';
import { CapacityError } from '@/lib/schedule/capacityBoard';

export const dynamic = 'force-dynamic';

// MANAGER QUEUE for capacity shift requests (migration 156).
//
// Kept separate from /pickups (a coworker's offered shift) and /claims (the legacy OT board)
// because the ownership semantics differ: a pickup MOVES a shift between two people, a capacity
// approval CREATES one that nobody owned. Same inline admin gate as its siblings, and the owner is
// always the session uid — never the body (the #217 discipline).

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
    return NextResponse.json({ ok: true, requests: await listShiftRequests(gate.user.id) });
  } catch (e) {
    console.error('[schedule/shift-requests] list:', (e as Error).message);
    return NextResponse.json({ error: 'Could not load shift requests.' }, { status: 500 });
  }
}

// POST { requestId, action: 'approve' | 'decline', note? }
//
// Approval revalidates EVERYTHING inside lensed_approve_shift_request under an advisory lock —
// including a fresh staffed recount — so a queue the manager has been staring at for ten minutes
// refuses rather than oversubscribing the floor.
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const requestId = String(body.requestId ?? '');
  const action = String(body.action ?? '');
  if (!requestId) return NextResponse.json({ error: 'Missing requestId' }, { status: 400 });
  if (action !== 'approve' && action !== 'decline') {
    return NextResponse.json({ error: "action must be 'approve' or 'decline'" }, { status: 400 });
  }

  try {
    if (action === 'decline') {
      await declineShiftRequest({ ownerId: gate.user.id, requestId, note: typeof body.note === 'string' ? body.note : null });
      return NextResponse.json({ ok: true, action: 'declined' });
    }
    const result = await approveShiftRequest({ ownerId: gate.user.id, requestId });
    return NextResponse.json({ ok: true, action: 'approved', ...result });
  } catch (e) {
    if (e instanceof CapacityError) {
      const status = e.code === 'REQUEST_NOT_FOUND' || e.code === 'BLOCK_NOT_FOUND' ? 404
        : e.code === 'APPROVE_FAILED' || e.code === 'DECLINE_FAILED' || e.code === 'READ_FAILED' ? 500
        : 409;
      if (status === 500) {
        console.error('[schedule/shift-requests]', e.code, e.message);
        return NextResponse.json({ error: 'Could not update this request.', code: e.code }, { status: 500 });
      }
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    console.error('[schedule/shift-requests]', (e as Error).message);
    return NextResponse.json({ error: 'Could not update this request.' }, { status: 500 });
  }
}
