import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

// Owner-only provisioning of the kiosk's internal token. In the login-account model kiosk_tokens is
// NOT a URL secret — it is the internal owner→token lookup the /api/kiosk/* routes hand to the
// service-role RPCs. The owner needs exactly ONE active row; this route reports whether one exists
// and creates one on demand. Runs under the OWNER's session (unconfined: role undefined or 'admin').
async function requireOwner(): Promise<
  { ok: true; ownerId: string } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, ownerId: user.id };
}

// GET /api/admin/kiosk-tokens — does the owner already have an active kiosk token?
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('kiosk_tokens')
    .select('id')
    .eq('user_id', gate.ownerId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ active: !!data });
}

// POST /api/admin/kiosk-tokens { store_id? } — ensure an active kiosk token exists for the owner
// (idempotent: no-op if one already exists). Optional store_id is validated to exist. The token
// value is internal and is NOT returned.
export async function POST(req: Request) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { ownerId } = gate;

  let body: { store_id?: unknown };
  try { body = await req.json().catch(() => ({})); } catch { body = {}; }
  const storeId = typeof body.store_id === 'string' && body.store_id.trim() ? body.store_id.trim() : null;

  const admin = createAdminClient();

  const { data: existing, error: exErr } = await admin
    .from('kiosk_tokens')
    .select('id')
    .eq('user_id', ownerId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
  if (existing) return NextResponse.json({ ok: true, active: true, created: false });

  if (storeId) {
    const { data: store, error: storeErr } = await admin.from('stores').select('id').eq('id', storeId).maybeSingle();
    if (storeErr) return NextResponse.json({ error: storeErr.message }, { status: 500 });
    if (!store) return NextResponse.json({ error: 'unknown store id' }, { status: 400 });
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const token = randomBytes(24).toString('base64url');
    const { error } = await admin
      .from('kiosk_tokens')
      .insert({ user_id: ownerId, store_id: storeId, token, active: true });
    if (!error) return NextResponse.json({ ok: true, active: true, created: true });
    if (error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });
    // 23505 = token collision (global or active-partial unique) — regenerate and retry.
  }
  console.error('[admin/kiosk-tokens] could not allocate a unique token after retries');
  return NextResponse.json({ error: 'Could not allocate a kiosk token, please retry' }, { status: 500 });
}
