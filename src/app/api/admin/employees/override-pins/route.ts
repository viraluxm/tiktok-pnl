import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// WHICH employees can authorise a pick override — never the PINs themselves.
//
// Returns ids only. The hash stays server-side: there is no reason a browser ever needs it,
// and shipping it would put a crackable low-entropy secret on every admin's machine.
//
// Having a PIN IS the authorisation, so this list is also the list of leads.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = user.app_metadata?.role as string | undefined;
  if (role && role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .not('override_pin_hash', 'is', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ employee_ids: (data ?? []).map((e) => e.id as string) });
}
