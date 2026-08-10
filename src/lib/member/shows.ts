import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

// Resolve a live session for the member `shows` scope and enforce ownership + store BEFORE any
// detail query. The session must belong to one of the member's owners AND (unless allStores) sit in
// the member's assigned stores — a 403, NOT an empty result, so a foreign / out-of-store session is
// a refusal rather than a deceptively-empty board. `selectCols` MUST include user_id and store_id.
export type OwnedSession =
  | { ok: true; session: Record<string, unknown>; ownerUserId: string }
  | { ok: false; response: NextResponse };

export async function resolveOwnedSession(
  admin: SupabaseClient,
  id: string,
  opts: { ownerIds: string[]; storeIds: string[]; allStores: boolean },
  selectCols: string,
): Promise<OwnedSession> {
  const { data, error } = await admin
    .from('live_sessions')
    .select(selectCols)
    .eq('id', id)
    .in('user_id', opts.ownerIds)
    .maybeSingle();
  if (error) return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) };
  const session = data as Record<string, unknown> | null;
  if (!session) return { ok: false, response: NextResponse.json({ error: 'session not in scope' }, { status: 403 }) };
  const storeId = (session.store_id as string | null) ?? null;
  if (!opts.allStores && (!storeId || !opts.storeIds.includes(storeId))) {
    return { ok: false, response: NextResponse.json({ error: 'session not in scope' }, { status: 403 }) };
  }
  return { ok: true, session, ownerUserId: String(session.user_id) };
}
