import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { verifyPin } from '@/lib/mapping/pin';
import { verifySupervisorIsOwner } from '@/lib/kiosk/supervisor';

export const dynamic = 'force-dynamic';

// A lead authorises a picker past a slot scan they cannot complete.
//
// This exists because scan verification without an escape hatch is worse than none: a
// damaged or unreadable label would hard-block the order, and a picker with no sanctioned
// way through invents an unsanctioned one. Then the data says "verified" and it isn't.
//
// Every override writes a row to pick_overrides — append-only, no update or delete policy —
// naming the picker, the authorising lead, the section and the reason. The RATE of those
// rows is the number worth watching, not the secrecy of any individual PIN: PINs drift
// because people watch each other type, but a lead authorising during shifts they did not
// work is legible in the log regardless.

// Attempts per user per window. A 4-digit PIN is 10,000 guesses, so the slow hash and this
// limit are what actually protect it.
//
// In-memory and therefore PER SERVER INSTANCE: on a multi-instance deploy an attacker gets
// this many tries per instance, not overall. That is a real weakening and is written down
// rather than glossed — a durable limiter needs a table, which is a migration this does not
// justify on its own. It still stops the obvious case of someone sitting at a device
// spraying codes.
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

  let body: {
    pin?: string;
    /** The account holder's own password, for the rare override no lead is present for. */
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
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  // Two ways to authorise, and the log records which.
  //
  // A LEAD types their PIN — the everyday path. THE OWNER types their own account password,
  // for the rare case where no lead is on the floor. The owner has no employees row (adding
  // one would put them in payroll, since computePay takes the whole list), so the owner path
  // records a name with no employee_id.
  //
  // verifySupervisorIsOwner establishes NO session: it signs in on a throwaway client with
  // persistSession false and signs straight back out with scope 'local'. That matters on a
  // station device — see CLAUDE.md on the capture extension's JWT, which a real sign-in here
  // would clobber. The email comes from the session, never the request body, so this can only
  // ever verify the account already signed in at this station.
  let authorisedBy: { id: string | null; name: string } | null = null;

  if (pin) {
    // Only employees who have been GIVEN a PIN can authorise — having one is the authorisation.
    const { data: authorisers, error: readErr } = await supabase
      .from('employees')
      .select('id, name, override_pin_hash')
      .eq('user_id', user.id)
      .not('override_pin_hash', 'is', null);
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    for (const e of authorisers ?? []) {
      if (await verifyPin(pin, e.override_pin_hash as string)) {
        authorisedBy = { id: e.id as string, name: (e.name as string) ?? 'Unknown' };
        break;
      }
    }
  } else if (user.email && await verifySupervisorIsOwner(user.email, ownerPassword, user.id)) {
    authorisedBy = { id: null, name: `${user.email} (account holder)` };
  }

  if (!authorisedBy) {
    // Deliberately does not say whether any PINs exist, or how many.
    return NextResponse.json(
      { error: pin ? 'That PIN was not recognised.' : 'That password was not recognised.' },
      { status: 403 },
    );
  }

  const { error: logErr } = await supabase.from('pick_overrides').insert({
    user_id: user.id,
    group_key: typeof body.group_key === 'string' ? body.group_key : null,
    slot_id: typeof body.slot_id === 'string' && body.slot_id ? body.slot_id : null,
    inventory_sku_id:
      typeof body.inventory_sku_id === 'string' && body.inventory_sku_id ? body.inventory_sku_id : null,
    picker_employee_id:
      typeof body.picker_employee_id === 'string' && body.picker_employee_id ? body.picker_employee_id : null,
    authorized_by_employee_id: authorisedBy.id,
    // Snapshot, so deleting an employee later cannot anonymise an override they granted —
    // and so an owner-authorised row is distinguishable from "we do not know". See 118.
    authorized_by_name: authorisedBy.name,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
  });

  // The override is AUTHORISED at this point. If the audit insert fails the picker is not
  // blocked — that would punish them for our problem — but the failure is surfaced so the
  // gap in the log is known rather than silent.
  if (logErr) {
    return NextResponse.json({
      ok: true,
      authorized_by: authorisedBy.name,
      warning: `Authorised, but the audit record failed to save: ${logErr.message}`,
    });
  }

  return NextResponse.json({ ok: true, authorized_by: authorisedBy.name });
}
