import 'server-only';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Shared gate for every /api/admin/training/* route.
//
// WHY STRICT role === 'admin', AND NOT THE `requireOwner` SHAPE USED ELSEWHERE.
// src/app/api/admin/badges/route.ts treats an UNDEFINED role as the owner (only the
// confined sub-user roles are rejected). That is right for badges, but wrong here:
// Practice Mode's pages sit under (app)/admin/layout.tsx, which redirects unless
// role === 'admin', and /api/training/video-token enforces the same strictly. An
// API that accepted a null role would be MORE permissive than the page it serves,
// and per the null-role finding in this project several production accounts do
// carry a null role with otherwise full access. So: match the page gate exactly.
//
// Practice Mode holds no customer data, but a practice session publishes a live
// camera — being able to enumerate, join or end other people's sessions is not
// something to hand out by accident.
export type TrainingAdminScope =
  | { ok: true; ownerId: string; actorId: string }
  | { ok: false; response: NextResponse };

export async function requireTrainingAdmin(): Promise<TrainingAdminScope> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (user.app_metadata?.role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  // All operational data in this database belongs to a single store owner, and the
  // sole role='admin' account IS that owner — so the acting admin is the owner.
  // ownerId and actorId are returned separately anyway so that when partners are
  // promoted to admin, only this function needs to learn the difference.
  return { ok: true, ownerId: user.id, actorId: user.id };
}
