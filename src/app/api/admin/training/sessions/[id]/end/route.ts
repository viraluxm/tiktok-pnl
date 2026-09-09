import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';

export const dynamic = 'force-dynamic';

// POST /api/admin/training/sessions/:id/end — a session finished CLEANLY.
//
// Sent when the 30-minute clock runs out (completePractice) and, best-effort, when
// the host tab goes away (pagehide via sendBeacon). It is only ever an optimisation:
// a session whose heartbeats simply stop decays to 'stale' by itself, so losing this
// call costs a label, never correctness. That is why the host treats a failure here
// as non-fatal.
//
// Idempotent: ending an already-ended session keeps the FIRST ended_at, so a beacon
// that lands after completePractice cannot push the finish time later.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('owner_id', gate.ownerId)
    .eq('id', id)
    .is('ended_at', null) // keep the first finish; a late duplicate matches nothing
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // No row = unknown id OR already ended. Both are a fine end state for a
  // best-effort call, so this is not an error.
  return NextResponse.json({ ok: true, ended: data !== null });
}
