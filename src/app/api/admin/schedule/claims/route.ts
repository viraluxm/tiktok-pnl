import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listPendingClaims, approveClaim, rejectClaim } from '@/lib/schedule/adminShifts';
import { ScheduleError } from '@/lib/schedule/release';

export const dynamic = 'force-dynamic';

// Pending OT-claim queue + approve/reject (Part 7). The OT gate STAYS human — this is where a
// manager acts on it. Admin-gated, same inline pattern as the token route.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

// GET → the pending-claims queue (for the panel + count badge).
export async function GET() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  try {
    const claims = await listPendingClaims();
    return NextResponse.json({ ok: true, claims });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST { claimId, action: 'approve' | 'reject' }
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
  if (action !== 'approve' && action !== 'reject') return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });

  try {
    if (action === 'approve') await approveClaim(claimId, gate.user.id);
    else await rejectClaim(claimId, gate.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ScheduleError) {
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'NOT_PENDING' || e.code === 'SHIFT_UNAVAILABLE' ? 409 : 500;
      return NextResponse.json({ error: e.message || e.code, code: e.code }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
