import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { isValidTrainingSessionId } from '@/lib/training/session';
import {
  isPracticePurpose,
  normalizeTraineeName,
  type PracticeRecordingRow,
  type PracticeSessionRow,
} from '@/lib/training/registry';

export const dynamic = 'force-dynamic';

// The Practice Mode session registry (see migration 136).
//
// Replaces the launcher's localStorage-only index, which was per-browser and so
// invisible to a second manager and lost on a cache clear. Admin-gated, and every
// query is scoped explicitly by owner_id — practice_sessions has RLS enabled with
// no policies, so the scoping in these queries IS the access control.

// The columns the client needs. Enumerated rather than select('*') so adding an
// internal column later cannot silently start shipping it to the browser.
const ROW_COLUMNS = 'id, trainee_name, purpose, created_at, started_at, ended_at, last_seen_at';

// The list additionally carries how many timeline events each session recorded, so
// History can say what is actually there to replay. PostgREST computes this as an
// embedded aggregate over the foreign key, so it costs no extra round trip and no
// event rows cross the wire.
const LIST_COLUMNS =
  `${ROW_COLUMNS}, practice_events(count), ` +
  // Each session's recordings, so History can say whether there is footage and
  // whether it failed. Embedded, so no extra round trip.
  `practice_recordings(id, status, duration_ms, size_bytes, error)`;

// GET /api/admin/training/sessions — every session for this owner, newest first.
// Status is NOT returned: it is derived from these timestamps by
// derivePracticeStatus so the server and the launcher can never disagree.
export async function GET() {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .select(LIST_COLUMNS)
    .eq('owner_id', gate.ownerId)
    .order('created_at', { ascending: false })
    // Practice sessions are transient and hand-created, so this ceiling is far
    // above any real usage — but it is stated explicitly because PostgREST
    // silently truncates at 1000 rows, and a silent truncation here would look
    // like sessions vanishing rather than like an error.
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Flatten the embedded aggregate — PostgREST returns it as practice_events:
  // [{count}] — into a plain number, so the client never has to know it came from
  // a join.
  // PostgREST returns the embedded aggregate as practice_events: [{count}] and the
  // embedded rows as practice_recordings: [...]. Flatten both so the client never
  // has to know they came from a join. Typed via an explicit shape rather than a
  // rest-spread, because supabase-js's inferred row type is a union that a rest
  // element cannot destructure.
  type RawRow = Omit<PracticeSessionRow, 'event_count' | 'recordings'> & {
    practice_events?: { count: number }[] | null;
    practice_recordings?: PracticeRecordingRow[] | null;
  };
  const sessions: PracticeSessionRow[] = ((data ?? []) as unknown as RawRow[]).map((row) => {
    const { practice_events: agg, practice_recordings: recs, ...rest } = row;
    return { ...rest, event_count: agg?.[0]?.count ?? 0, recordings: recs ?? [] };
  });

  return NextResponse.json({ sessions }, { headers: { 'Cache-Control': 'no-store' } });
}

// POST /api/admin/training/sessions { trainee_name?, purpose?, id? }
//
// Mints a session. The id is generated SERVER-side (the launcher no longer invents
// one) so the registry row is the authority for what session ids exist.
//
// `id` is accepted for ONE purpose: importing a session that already exists in a
// browser's legacy localStorage list, so switching the launcher over to the
// registry cannot strand a practice live that is running right now with a
// published camera. It is validated as a canonical uuid, and a re-import is a
// no-op rather than an error (see the conflict handling below).
export async function POST(req: Request) {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as {
    trainee_name?: unknown;
    purpose?: unknown;
    id?: unknown;
  };

  // An explicit id must be a canonical uuid — the same validator the host and
  // controller pages fail closed on, so the registry can never hold an id that
  // those pages would reject.
  let id: string;
  if (body.id === undefined) {
    id = crypto.randomUUID();
  } else if (isValidTrainingSessionId(body.id)) {
    id = body.id;
  } else {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  // Default rather than reject: the launcher's create button does not always know
  // the purpose yet, and 'training' is the safe, common case.
  const purpose = isPracticePurpose(body.purpose) ? body.purpose : 'training';

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('practice_sessions')
    .insert({
      id,
      owner_id: gate.ownerId,
      created_by: gate.actorId,
      trainee_name: normalizeTraineeName(body.trainee_name),
      purpose,
    })
    .select(ROW_COLUMNS)
    .single();

  if (error) {
    // 23505 = unique_violation on the primary key: this id is already registered.
    // For an import that is the desired end state, not a failure, so return the
    // existing row (scoped to this owner) and let the caller carry on.
    if (error.code === '23505') {
      const { data: existing } = await admin
        .from('practice_sessions')
        .select(ROW_COLUMNS)
        .eq('owner_id', gate.ownerId)
        .eq('id', id)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ session: existing as PracticeSessionRow, imported: false });
      }
      // The id exists but under a DIFFERENT owner. Say "taken" without confirming
      // whose it is.
      return NextResponse.json({ error: 'Session id already in use' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ session: data as PracticeSessionRow, imported: true }, { status: 201 });
}
