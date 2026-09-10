import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/ext/relay-eligible — may this session's JWT be handed to the capture extension?
//
// The web app is the extension's only token source (the single-refresher model), and the extension
// writes capture_events under whatever user_id that token carries. So the answer is simply: does
// this user OWN a store? A non-owner signing in on a capture machine must NOT replace the JWT —
// see @/lib/extension/relayEligibility for the full failure mode.
//
// Answers, never 401s: "not signed in" is a legitimate no, and the client fails closed on errors,
// so a status code is a poor channel for it. A 5xx here means "no answer", and the client retries.
//
// store_members has RLS disabled (see migration 075), so the user_id filter below is the only
// thing scoping this read — it is written into the query, never inferred.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ eligible: false, reason: 'no-session' });

  const { data, error } = await supabase
    .from('store_members')
    .select('store_id')
    .eq('user_id', user.id)
    .eq('role', 'owner')
    .limit(1);

  if (error) {
    console.error('[ext/relay-eligible] store_members lookup failed:', error.message);
    return NextResponse.json({ error: 'eligibility unresolved' }, { status: 500 });
  }

  const eligible = (data ?? []).length > 0;
  if (!eligible) {
    // Worth a line in the server log: it means someone who is not a store owner has the dashboard
    // open, which on a capture machine is exactly the situation this endpoint exists to stop.
    console.warn('[ext/relay-eligible] withholding relay: user %s owns no store', user.id);
  }
  return NextResponse.json({ eligible, reason: eligible ? 'store-owner' : 'not-a-store-owner' });
}
