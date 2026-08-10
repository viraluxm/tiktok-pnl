import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/schedule/host-live-hours
//
// Returns the raw live-session intervals the client needs to compute per-(host, Pacific-day) live
// hours (see src/lib/schedule/liveHours.ts). READ-ONLY. Server-side because live_sessions has RLS
// on and is read through the user-scoped session (same pattern as /api/live/host-performance) — a
// client `from('live_sessions')` isn't used anywhere in the app.
//
// The dataset is tiny (~hundreds of rows), so this returns ALL of the user's sessions rather than
// a date-filtered slice — that guarantees a session which started before the window but ended
// inside it (or crosses a Pacific midnight) is never missed. The pure lib does the day clipping,
// reliable-source filtering, union, and the four data states.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('live_sessions')
    .select('host_id, status, started_at, ended_at, end_source');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ sessions: data ?? [] });
}
