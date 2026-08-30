import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { hashPin, isValidPinFormat } from '@/lib/mapping/pin';

export const dynamic = 'force-dynamic';

// Set or clear an employee's OVERRIDE PIN — the code a lead types to let a picker past a
// slot scan they cannot complete.
//
// Owner-gated, following the same shape as the employee photo route.
//
// Having a PIN IS the authorisation: there is no separate "is a lead" flag, so clearing the
// PIN is how you revoke it. employees.role is deliberately untouched — it feeds payroll
// filtering and is constrained to pay-role classes, so putting authorisation there could
// move money.
//
// Per-lead PINs rather than one shared code, because a shared code becomes floor knowledge
// and pickers then self-authorise while the log still reads "authorised". Per-person PINs
// make that visible: the authorising lead can be cross-checked against who was clocked in.
//
// The PIN is hashed here and never stored, returned or logged in the clear.
async function requireOwner(): Promise<{ ok: true; ownerId: string } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { ok: true, ownerId: user.id };
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { id } = await params;

  let body: { pin?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  const supabase = await createClient();

  // Scope to the caller's own employees. The FK does not do this for us.
  const { data: employee, error: readErr } = await supabase
    .from('employees').select('id, name').eq('id', id).eq('user_id', gate.ownerId).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

  // null / empty clears the PIN, which is how override authority is revoked.
  const raw = typeof body.pin === 'string' ? body.pin.trim() : null;
  if (raw && !isValidPinFormat(raw)) {
    return NextResponse.json({ error: 'A PIN must be 4 to 8 digits.' }, { status: 400 });
  }

  const override_pin_hash = raw ? await hashPin(raw) : null;
  const { error } = await supabase
    .from('employees').update({ override_pin_hash }).eq('id', id).eq('user_id', gate.ownerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, name: employee.name, has_pin: !!override_pin_hash });
}
