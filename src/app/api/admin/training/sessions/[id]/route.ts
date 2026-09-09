import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';
import { normalizeTraineeName, type PracticeSessionRow } from '@/lib/training/registry';

export const dynamic = 'force-dynamic';

const ROW_COLUMNS = 'id, trainee_name, purpose, created_at, started_at, ended_at, last_seen_at';

// PATCH /api/admin/training/sessions/:id { trainee_name }
// Name a session after it was created — a candidate's name is often known only
// once they join, so the launcher allows filling it in later.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { trainee_name?: unknown };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .update({ trainee_name: normalizeTraineeName(body.trainee_name) })
    .eq('owner_id', gate.ownerId) // scoping IS the access control — RLS has no policies
    .eq('id', id)
    .select(ROW_COLUMNS)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ session: data as PracticeSessionRow });
}

// DELETE /api/admin/training/sessions/:id — discard a link created by mistake.
//
// ONLY WHILE started_at IS NULL. A session that has actually RUN can never be
// deleted, because it is the parent of its recording and its event timeline
// (Deploys 3 and 4): deleting it would silently shed the replay. Sessions that ran
// are finished with ended_at and move to the launcher's History section instead —
// there is no UI path to delete one, and this route refuses even if called
// directly.
//
// A never-started session, by definition, has no heartbeat, no footage and no
// events, so discarding it loses nothing. That is the whole and only case this
// route serves: a fat-fingered create.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();
  // The `is('started_at', null)` predicate IS the guard — enforced in the DELETE
  // itself rather than by a read-then-write, so a session that starts between the
  // check and the delete cannot slip through.
  const { data, error } = await admin
    .from('practice_sessions')
    .delete()
    .eq('owner_id', gate.ownerId)
    .eq('id', id)
    .is('started_at', null)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!data) {
    // Nothing deleted: either it never existed, or it has run. Distinguish them so
    // the refusal is explainable rather than a bare 404.
    const { data: existing } = await admin
      .from('practice_sessions')
      .select('started_at')
      .eq('owner_id', gate.ownerId)
      .eq('id', id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(
      { error: 'This session has already run and is kept in history — it cannot be deleted.' },
      { status: 409 },
    );
  }

  return NextResponse.json({ removed: id });
}
