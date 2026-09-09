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

// DELETE /api/admin/training/sessions/:id — the launcher's "Remove".
//
// A HARD DELETE, deliberately. A registry row carries no history worth keeping on
// its own: it is a link plus four timestamps. Once recordings exist (Deploy 4) they
// reference this row, and THAT is when removal must become a soft end rather than a
// delete — the FK in migration 138 will be written ON DELETE CASCADE precisely so
// this decision has to be revisited then rather than silently shedding recordings.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  if (!isValidTrainingSessionId(id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .delete()
    .eq('owner_id', gate.ownerId)
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ removed: id });
}
