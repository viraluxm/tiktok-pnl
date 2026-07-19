import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// Admin: directly attribute a SINGLE live session to a store by session id.
//
// This rescues sessions the channel→store mapping can't reach: a session with
// channel_handle IS NULL (extension never persisted a channel) is stuck in the
// "unmapped" flag because the name-match backfill has no handle to match. Rather
// than wait on an extension re-capture, an admin assigns the store directly here.
//
// Web-only, and deliberately narrow: it ONLY sets live_sessions.store_id, and ONLY
// on a currently-unmapped (store_id IS NULL) session — it never touches the
// auction/capture write path and never overwrites an already-attributed store.
//
// Uses the service-role client (RLS is user-scoped; an admin acts across owners),
// gated on app_metadata.role === 'admin' — same pattern as /api/admin/channels.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id: sessionId } = await params;

  let store_id: string | null = null;
  try {
    const b = await req.json();
    if (typeof b?.store_id === 'string') store_id = b.store_id.trim();
  } catch { /* handled below */ }
  if (!sessionId || !store_id) {
    return NextResponse.json({ error: 'session id and store_id are required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // STRICT org validation. The admin may only assign a session to a store in an org
  // they belong to, AND only when the session's owner is in that same org — so an
  // admin can never move another org's session, nor point a session at a foreign store.
  const { data: adminOrgs } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id);
  const adminOrgIds = new Set((adminOrgs ?? []).map((o) => o.org_id as string));
  if (adminOrgIds.size === 0) {
    return NextResponse.json({ error: 'Admin is not a member of any organization' }, { status: 403 });
  }

  // Store must exist and belong to one of the admin's orgs.
  const { data: store } = await admin
    .from('stores')
    .select('id, org_id')
    .eq('id', store_id)
    .maybeSingle();
  if (!store) return NextResponse.json({ error: 'Unknown store_id' }, { status: 400 });
  if (!adminOrgIds.has(store.org_id as string)) {
    return NextResponse.json({ error: 'Store is not in your organization' }, { status: 403 });
  }

  // Session must exist and be currently unmapped (never overwrite an assigned store).
  const { data: session } = await admin
    .from('live_sessions')
    .select('id, user_id, store_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (session.store_id) {
    return NextResponse.json({ error: 'Session is already attributed to a store' }, { status: 409 });
  }

  // The session's owner must be a member of the target store's org (cross-org isolation).
  const { data: ownerMember } = await admin
    .from('organization_members')
    .select('user_id')
    .eq('org_id', store.org_id as string)
    .eq('user_id', session.user_id as string)
    .maybeSingle();
  if (!ownerMember) {
    return NextResponse.json({ error: 'Session does not belong to that store\'s organization' }, { status: 403 });
  }

  // Assign. Guarded on store_id IS NULL so a concurrent assignment can't be clobbered.
  const { data: updated, error: upErr } = await admin
    .from('live_sessions')
    .update({ store_id })
    .eq('id', sessionId)
    .is('store_id', null)
    .select('id, store_id')
    .maybeSingle();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: 'Session was already attributed (race)' }, { status: 409 });

  return NextResponse.json({ id: updated.id, store_id: updated.store_id });
}
