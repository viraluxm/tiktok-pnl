import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyPin } from '@/lib/mapping/pin';
import { verifySupervisorIsOwner } from '@/lib/kiosk/supervisor';

export const dynamic = 'force-dynamic';

// POST /api/station/override — the station's copy of the pick override.
//
// It has to live under /api/station because the station role is hard-confined to
// ['/fulfillment', '/api/station'] (see STATION_CONFINEMENT). A station device calling
// /api/shipping/pick-override is a middleware 403 before the handler ever runs, so shipping
// the override without this mirror would have left it working on the owner login and dead on
// the fulfilment login — which is the login it is actually for.
//
// Like the rest of /api/station, the caller owns no data: the station's own user_id has no
// employees, no sections and no orders. Everything resolves to the store OWNERS via
// store_members, through the service role, and NEVER to the caller.

const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || now > cur.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'station') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    pin?: string;
    owner_password?: string;
    group_key?: string;
    inventory_sku_id?: string;
    slot_id?: string | null;
    picker_employee_id?: string | null;
    reason?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  const ownerPassword = typeof body.owner_password === 'string' ? body.owner_password : '';
  if (!pin && !ownerPassword) {
    return NextResponse.json({ error: 'A PIN is required.' }, { status: 400 });
  }
  if (rateLimited(user.id)) {
    return NextResponse.json({ error: 'Too many attempts. Wait a few minutes and try again.' }, { status: 429 });
  }

  const admin = createAdminClient();

  const { data: owners, error: ownersErr } = await admin
    .from('store_members').select('user_id').eq('role', 'owner');
  if (ownersErr) return NextResponse.json({ error: ownersErr.message }, { status: 500 });
  const ownerIds = [...new Set((owners ?? []).map((o) => String(o.user_id)))];
  // Same fail-loud stance as station/scan: an unresolved scope must not quietly behave like a
  // wrong PIN, or a config problem gets mistaken for a lead mistyping.
  if (!ownerIds.length) {
    console.error('[station/override] station scope unresolved: no store_members(role=owner) rows');
    return NextResponse.json({ error: 'station scope unresolved' }, { status: 500 });
  }

  let authorisedBy: { id: string | null; name: string; ownerId: string } | null = null;

  if (pin) {
    const { data: authorisers, error: readErr } = await admin
      .from('employees')
      .select('id, name, user_id, override_pin_hash')
      .in('user_id', ownerIds)
      .not('override_pin_hash', 'is', null);
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    for (const e of authorisers ?? []) {
      if (await verifyPin(pin, e.override_pin_hash as string)) {
        authorisedBy = {
          id: e.id as string,
          name: (e.name as string) ?? 'Unknown',
          ownerId: String(e.user_id),
        };
        break;
      }
    }
  } else {
    // Owner password. The station session is NOT the owner, so the email is looked up from the
    // resolved owner ids server-side — never taken from the request, which would let a caller
    // nominate whose password they are testing.
    //
    // verifySupervisorIsOwner establishes no session (throwaway client, persistSession false,
    // signed out scope 'local'), which is what makes it safe to use on a station device at
    // all — see CLAUDE.md on the capture extension's JWT.
    for (const ownerId of ownerIds) {
      const { data: got } = await admin.auth.admin.getUserById(ownerId);
      const email = got?.user?.email;
      if (!email) continue;
      if (await verifySupervisorIsOwner(email, ownerPassword, ownerId)) {
        authorisedBy = { id: null, name: `${email} (account holder)`, ownerId };
        break;
      }
    }
  }

  if (!authorisedBy) {
    return NextResponse.json(
      { error: pin ? 'That PIN was not recognised.' : 'That password was not recognised.' },
      { status: 403 },
    );
  }

  // The audit row belongs to the OWNER, not the station — pick_overrides is owner-scoped and
  // the station's own user_id owns nothing.
  const { error: logErr } = await admin.from('pick_overrides').insert({
    user_id: authorisedBy.ownerId,
    group_key: typeof body.group_key === 'string' ? body.group_key : null,
    slot_id: typeof body.slot_id === 'string' && body.slot_id ? body.slot_id : null,
    inventory_sku_id:
      typeof body.inventory_sku_id === 'string' && body.inventory_sku_id ? body.inventory_sku_id : null,
    picker_employee_id:
      typeof body.picker_employee_id === 'string' && body.picker_employee_id ? body.picker_employee_id : null,
    authorized_by_employee_id: authorisedBy.id,
    authorized_by_name: authorisedBy.name,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
  });

  if (logErr) {
    return NextResponse.json({
      ok: true,
      authorized_by: authorisedBy.name,
      warning: `Authorised, but the audit record failed to save: ${logErr.message}`,
    });
  }

  return NextResponse.json({ ok: true, authorized_by: authorisedBy.name });
}
