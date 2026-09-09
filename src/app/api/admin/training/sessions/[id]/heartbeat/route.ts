import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';

export const dynamic = 'force-dynamic';

// POST /api/admin/training/sessions/:id/heartbeat
//
// The running host says "still here". Called roughly every PRACTICE_HEARTBEAT_MS,
// throttled off the host's EXISTING per-second session tick — no new timer.
//
// WHY THE HEARTBEAT ALSO STAMPS started_at. Creating a session in the launcher only
// mints a link; the session has not begun until a host grants camera access and
// starts. The first heartbeat is precisely that moment, so it sets started_at once
// (coalesce, so later beats never move it) and this route stays the only writer of
// both timestamps. An audition that was never opened therefore keeps started_at
// null forever, which is how a no-show stays visible.
//
// LIVENESS IS DERIVED, NOT STORED (migration 136 design note b): this writes
// last_seen_at and nothing else, so a host that dies decays to 'stale' on its own
// with no cron to reconcile.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();
  // A raw UPDATE cannot express `started_at = coalesce(started_at, now())`, and a
  // read-then-write would race two tabs of the same session. Two narrow statements
  // instead: an unconditional touch, then a one-shot stamp that only ever matches
  // while started_at IS NULL. Both are idempotent and order-independent.
  const nowIso = new Date().toISOString();

  const { data, error } = await admin
    .from('practice_sessions')
    .update({ last_seen_at: nowIso })
    .eq('owner_id', gate.ownerId)
    .eq('id', id)
    .select('id, started_at, ended_at')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Unknown id, or someone else's: the host is beating for a session that is not
  // registered. Report it so the host can surface "this session is not registered"
  // rather than silently appearing offline in every manager's launcher.
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (data.started_at === null) {
    await admin
      .from('practice_sessions')
      .update({ started_at: nowIso })
      .eq('owner_id', gate.ownerId)
      .eq('id', id)
      .is('started_at', null); // one-shot: a concurrent beat that already stamped wins
  }

  // A heartbeat on an already-ended session RE-OPENS it, because the host really is
  // live again — restartPractice() reuses the same session id for a second run, and
  // a run in progress must never read as ended.
  if (data.ended_at !== null) {
    await admin
      .from('practice_sessions')
      .update({ ended_at: null })
      .eq('owner_id', gate.ownerId)
      .eq('id', id);
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
