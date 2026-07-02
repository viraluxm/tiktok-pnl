import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// The shared org "fulfillment" auth account + per-device token utilities (chunk 6).
// The account is created once per org (admin API), added to organization_members role
// 'fulfillment' (NOT store_members → no store surface). Its password is DERIVED from a
// server secret so the provisioning server can sign in and hand a session to the device
// (server-hands-session) without ever storing or transmitting a static password to devices.

export const fulfillmentEmail = (orgId: string) => `fulfillment+${orgId}@lensed.internal`;

export function deriveFulfillmentPassword(orgId: string): string {
  const secret = process.env.ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'lensed-dev-secret';
  return crypto.createHmac('sha256', secret).update(`fulfillment-account:${orgId}`).digest('base64url');
}

export const generateDeviceToken = () => crypto.randomBytes(24).toString('base64url'); // high-entropy
export const hashDeviceToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// Idempotent: ensure the org's shared fulfillment auth user exists, has the derived password,
// and is an org member (role 'fulfillment'). Returns its user id + email.
export async function ensureFulfillmentAccount(admin: SupabaseClient, orgId: string): Promise<{ userId: string; email: string }> {
  const email = fulfillmentEmail(orgId);
  const password = deriveFulfillmentPassword(orgId);

  let userId: string | null = null;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created?.user) {
    userId = created.user.id;
  } else {
    // already exists → find it, and (re)set the derived password so provisioning can sign in
    for (let page = 1; page <= 20 && !userId; page++) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      const u = data?.users?.find((x) => x.email === email);
      if (u) userId = u.id;
      if (!data || (data.users?.length ?? 0) < 1000) break;
    }
    if (userId) await admin.auth.admin.updateUserById(userId, { password });
  }
  if (!userId) throw new Error(`ensureFulfillmentAccount: could not create/find account (${error?.message ?? 'unknown'})`);

  // org membership (role 'fulfillment'); NOT a store_members row.
  const { error: mErr } = await admin
    .from('organization_members')
    .upsert({ org_id: orgId, user_id: userId, role: 'fulfillment' }, { onConflict: 'org_id,user_id' });
  if (mErr) throw new Error(`ensureFulfillmentAccount: membership failed (${mErr.message})`);

  return { userId, email };
}
