import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient as createSbClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { ensureFulfillmentAccount, generateDeviceToken, hashDeviceToken, fulfillmentEmail, deriveFulfillmentPassword } from '@/lib/fulfillment/fulfillmentAccount';

export const dynamic = 'force-dynamic';

// POST { kind, label } — OWNER provisions a warehouse device.
// Inserts the device (RLS is_store_owner_in_org enforces owner), ensures the shared org
// fulfillment account, signs in AS that account server-side, and returns a one-time
// provisioning payload { device_id, kind, token, session } for the physical device to
// ingest (chunk 7). The device never sees the shared password (server-hands-session).
export async function POST(req: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Owner gate (RLS also enforces on the insert; this yields a clean 403).
  const { data: isOwner } = await supabase.rpc('is_store_owner_in_org', { p_org: orgId });
  if (isOwner !== true) return NextResponse.json({ error: 'FORBIDDEN', message: 'Only store owners can provision devices' }, { status: 403 });

  let body: { kind?: string; label?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const kind = body.kind === 'picker' || body.kind === 'packer' ? body.kind : '';
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  if (!kind) return NextResponse.json({ error: 'kind must be picker or packer' }, { status: 400 });

  const token = generateDeviceToken();
  const { data: device, error } = await supabase
    .from('fulfillment_devices')
    .insert({ org_id: orgId, kind, label: label || null, device_token_hash: hashDeviceToken(token), provisioned_by: user.id })
    .select('id, kind, label').single();
  if (error || !device) return NextResponse.json({ error: 'Failed to create device', detail: error?.message }, { status: 500 });

  // Ensure the shared account, then mint a session for it (fresh client so the owner's
  // session isn't disturbed).
  try {
    const admin = createAdminClient();
    await ensureFulfillmentAccount(admin, orgId);
    const sb = createSbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: sess, error: sErr } = await sb.auth.signInWithPassword({ email: fulfillmentEmail(orgId), password: deriveFulfillmentPassword(orgId) });
    if (sErr || !sess.session) throw new Error(sErr?.message ?? 'no session');
    return NextResponse.json({
      device_id: device.id, kind: device.kind, label: device.label,
      token,                                   // plaintext — shown ONCE
      session: { access_token: sess.session.access_token, refresh_token: sess.session.refresh_token },
    });
  } catch (e) {
    // Device row was created; session mint failed — surface it (owner can retry/re-provision).
    return NextResponse.json({ error: 'Device created but session mint failed', detail: (e as Error).message, device_id: device.id }, { status: 500 });
  }
}
