import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireTrainingAdmin } from '@/lib/training/adminGuard';
import { reconcileRecordings } from '@/lib/training/reconcileRecordings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/admin/training/recording/reconcile
//
// Completes recordings the webhook never reported on, by asking LiveKit directly.
// Idempotent — safe to call on every launcher poll. See reconcileRecordings for why
// this is not simply trusting the webhook.
export async function POST() {
  const gate = await requireTrainingAdmin();
  if (!gate.ok) return gate.response;
  const result = await reconcileRecordings(createAdminClient(), gate.ownerId);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
