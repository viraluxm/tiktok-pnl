import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { autoEndSessions } from '@/lib/sessions/autoEnd';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST: TIMEOUT AUTO-ENDER (manual, admin). Thin wrapper over the shared core in
// @/lib/sessions/autoEnd — the SAME code path the scheduled cron uses
// (src/app/api/cron/auto-end-sessions). Closing logic lives entirely in the helper;
// this route only does admin auth + dry_run parsing. See docs/session-end-signal.md.
//
// dry_run defaults TRUE (compute-only). dry_run:false performs the writes.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  let body: { dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* no body → defaults */ }
  const dryRun = body.dry_run !== false; // default TRUE

  try {
    const result = await autoEndSessions({ write: !dryRun });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
