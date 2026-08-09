import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateAccessToken } from '@/lib/schedule/tokens';
import { onboardingMessage, tokenLink, sendSms } from '@/lib/schedule/sms';

export const dynamic = 'force-dynamic';

// Minimal token admin (Deploy B, Part 7 — enough to test; the full Phase 7 UI comes later).
// Gated on app_metadata.role === 'admin' — same inline pattern as the other /api/admin routes.
// This is admin-authenticated (session-based, correctly caught by middleware) — it is NOT one of
// the public /s/* routes.

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.app_metadata?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user };
}

// POST { employeeId }  → mint a fresh 32-byte base64url token for the employee, return its link.
// Fires the onboarding SMS (log-only until SMS_SEND_ENABLED).
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let employeeId: string;
  try {
    employeeId = String((await req.json()).employeeId ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!employeeId) return NextResponse.json({ error: 'Missing employeeId' }, { status: 400 });

  const admin = createAdminClient();
  const { data: emp, error: eErr } = await admin
    .from('employees')
    .select('id, user_id, name, phone')
    .eq('id', employeeId)
    .maybeSingle();
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 });
  if (!emp) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  const token = generateAccessToken();
  const { data: row, error } = await admin
    .from('employee_access_tokens')
    .insert({ user_id: emp.user_id, employee_id: emp.id, token, active: true })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const link = tokenLink(token);
  if (emp.phone) await sendSms(emp.phone, onboardingMessage(link), 'onboarding');

  return NextResponse.json({ ok: true, tokenId: row.id, token, link });
}

// DELETE { tokenId }  → revoke a token (active=false, revoked_at=now). Idempotent.
export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if ('error' in gate) return gate.error;

  let tokenId: string;
  try {
    tokenId = String((await req.json()).tokenId ?? '');
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!tokenId) return NextResponse.json({ error: 'Missing tokenId' }, { status: 400 });

  const { error } = await createAdminClient()
    .from('employee_access_tokens')
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq('id', tokenId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
