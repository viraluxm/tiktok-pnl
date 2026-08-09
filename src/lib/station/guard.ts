import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Shared gate for every /api/station/* route. The station's own auth user owns NO sales data —
// orders, auction items, inventory and employees all belong to the store OWNERS — so each route
// runs with the service role, scoped to the owner user_ids resolved from store_members
// (role='owner'), NEVER to the caller. Mirrors /api/station/scan's own inline gate.
//
// Fail closed: an empty owner set is a CONFIG failure (500 'station scope unresolved'), never a
// silent empty scan/box list — see the notes on /api/station/scan.
export type StationScope =
  | { ok: true; admin: SupabaseClient; ownerIds: string[] }
  | { ok: false; response: NextResponse };

export async function requireStationScope(): Promise<StationScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'station') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const admin = createAdminClient();
  const { data: owners, error } = await admin
    .from('store_members')
    .select('user_id')
    .eq('role', 'owner');
  if (error) return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) };

  const ownerIds = [...new Set((owners ?? []).map((o) => String(o.user_id)))];
  if (!ownerIds.length) {
    console.error('[station] station scope unresolved: no store_members(role=owner) rows');
    return { ok: false, response: NextResponse.json({ error: 'station scope unresolved' }, { status: 500 }) };
  }
  return { ok: true, admin, ownerIds };
}
