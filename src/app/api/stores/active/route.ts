import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { ACTIVE_STORE_COOKIE } from '@/lib/tiktok/activeStore';

export const dynamic = 'force-dynamic';

// The ONLY writer of the lensed_active_store cookie. Sets which store connection-
// bound + analytics routes act on. 'all' is always allowed; a specific store_id must
// belong to the caller (store_members).
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { store_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const storeId = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  if (!storeId) return NextResponse.json({ error: 'Missing store_id' }, { status: 400 });

  if (storeId !== 'all') {
    const { data: membership } = await supabase
      .from('store_members')
      .select('store_id')
      .eq('user_id', user.id)
      .eq('store_id', storeId)
      .maybeSingle();
    if (!membership) return NextResponse.json({ error: 'Not a member of this store' }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_STORE_COOKIE, storeId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // persist the selection
  });
  return NextResponse.json({ ok: true, activeStore: storeId });
}
