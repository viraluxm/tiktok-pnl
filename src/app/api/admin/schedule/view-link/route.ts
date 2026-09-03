import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateTeamScheduleToken } from '@/lib/schedule/teamScheduleToken';

export const dynamic = 'force-dynamic';

// Mint / read / revoke the owner's ONE read-only team-schedule link (migration 119).
// Admin-gated, same inline pattern as the claims + instances routes.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

// GET → the active token, if one exists.
export async function GET() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('team_schedule_tokens')
    .select('token')
    .eq('user_id', gate.user.id)
    .eq('active', true)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, token: data?.token ?? null });
}

// POST → ensure an active token exists (idempotent: returns the existing one rather than
// rotating, so sharing the link twice does not silently invalidate the copy already sent out).
export async function POST() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from('team_schedule_tokens')
    .select('token')
    .eq('user_id', gate.user.id)
    .eq('active', true)
    .maybeSingle();
  if (existing?.token) return NextResponse.json({ ok: true, token: existing.token });

  const token = generateTeamScheduleToken();
  const { error } = await admin
    .from('team_schedule_tokens')
    .insert({ user_id: gate.user.id, token, active: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, token });
}

// DELETE → revoke. The partial unique index frees the slot, so a later POST mints a fresh link.
export async function DELETE() {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;
  const admin = createAdminClient();
  const { error } = await admin
    .from('team_schedule_tokens')
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq('user_id', gate.user.id)
    .eq('active', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
