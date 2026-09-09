import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

// ── seller (external seller) ────────────────────────────────────────────────────────────────
// Shared gate for every /api/seller/* route.
//
// A seller is NOT a sub-user. Station, member and timeclock accounts own no data and read as the
// store OWNERS; a seller owns their own shop, shows, orders and labels under their own user_id.
// So this guard resolves TWO different things and never mixes them:
//
//   userId — the caller. Everything of THEIRS is scoped to this, exactly like the owner's own
//            routes do it. There is no owner resolution here and there must never be one.
//   orgId  — the organization whose INVENTORY they may read. That is the only thing they see of
//            ours, and it is the point of the arrangement: they sell from our shared stock.
//
// The org comes from app_metadata.org_id if stamped, else the caller's own organization_members
// row — never from a request parameter. It returns the CALLER's client (not service-role) so the
// org RLS on the shared tables still applies underneath the explicit filters routes write.
// Nothing here can widen a scope: worst case it resolves nothing and the route fails closed.
export type SellerScope =
  | { ok: true; supabase: SupabaseClient; userId: string; orgId: string }
  | { ok: false; response: NextResponse };

export async function requireSellerScope(): Promise<SellerScope> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  // Fail closed on the role. Middleware confines a seller to this namespace already; this is the
  // second gate, so a routing change alone can never expose these routes to another role.
  if (user.app_metadata?.role !== 'seller') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const stamped = user.app_metadata?.org_id;
  const orgId =
    typeof stamped === 'string' && stamped.trim() !== ''
      ? stamped.trim()
      : await getOrgId(supabase, user.id);

  if (!orgId) {
    // A seller with no organization has no shared inventory to read. That is a provisioning
    // failure, not an empty catalog — say so rather than rendering an empty shelf.
    console.error('[seller] no organization for seller %s', user.id);
    return { ok: false, response: NextResponse.json({ error: 'seller scope unresolved' }, { status: 500 }) };
  }

  return { ok: true, supabase, userId: user.id, orgId };
}
