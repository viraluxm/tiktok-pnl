import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { hashDeviceToken } from '@/lib/fulfillment/fulfillmentAccount';

export const dynamic = 'force-dynamic';

// POST { token } — the DEVICE (running under the shared fulfillment session) validates its
// per-device token. Resolves an ACTIVE device by sha256(token) (org-RLS read lets the
// fulfillment account see its org's device rows), bumps last_seen_at, and returns
// { device_id, kind, org_id }. Revoked (is_active=false) or unknown → valid:false so the
// device locks itself out and prompts re-provision. Other devices are unaffected.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { token?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ valid: false, reason: 'no_token' });

  const { data: device } = await supabase
    .from('fulfillment_devices')
    .select('id, kind, org_id, is_active')
    .eq('device_token_hash', hashDeviceToken(token))
    .maybeSingle();

  if (!device) return NextResponse.json({ valid: false, reason: 'unprovisioned' });
  if (!device.is_active) return NextResponse.json({ valid: false, reason: 'revoked' });

  await supabase.rpc('touch_device', { p_device_id: device.id }); // telemetry (definer)
  return NextResponse.json({ valid: true, device_id: device.id, kind: device.kind, org_id: device.org_id });
}
