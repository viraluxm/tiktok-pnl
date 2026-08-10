import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import { resolveOwnedSession } from '@/lib/member/shows';

export const dynamic = 'force-dynamic';

// Owner-scoped mirror of /api/live/sessions/[id]/duration for the member 'shows' scope.
// Read-only. The session's ownership + store are verified (403) before any capture query.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireMemberScope('shows');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const owned = await resolveOwnedSession(admin, id, { ownerIds, storeIds, allStores },
    'user_id, store_id, id, started_at, ended_at');
  if (!owned.ok) return owned.response;
  const { session, ownerUserId } = owned;
  const started_at = session.started_at as string | null;
  const ended_at = session.ended_at as string | null;

  // Most recent capture in the session window = end of active selling.
  let q = admin
    .from('capture_events')
    .select('created_at')
    .eq('user_id', ownerUserId)
    .gte('created_at', started_at)
    .order('created_at', { ascending: false })
    .limit(1);
  if (ended_at) q = q.lte('created_at', ended_at);
  const { data: lastCap } = await q;
  const last_capture_at: string | null = lastCap?.[0]?.created_at ?? null;

  // Prefer ended_at only when it's sane (after start, not wildly past the last sale); else last-capture.
  let source: 'ended_at' | 'last_capture' = 'last_capture';
  let end: string | null = last_capture_at;
  if (ended_at && started_at) {
    const s = new Date(started_at).getTime();
    const e = new Date(ended_at).getTime();
    const lc = last_capture_at ? new Date(last_capture_at).getTime() : null;
    const sane = e > s && (lc == null || e <= lc + 6 * 3600 * 1000);
    if (sane) { source = 'ended_at'; end = ended_at; }
  }

  const duration_ms = end && started_at ? new Date(end).getTime() - new Date(started_at).getTime() : null;
  return NextResponse.json({ started_at, ended_at, last_capture_at, duration_ms, source });
}
