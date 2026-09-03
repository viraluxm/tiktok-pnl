import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveShowDuration } from '@/lib/shows/duration';

export const dynamic = 'force-dynamic';

// GET /api/live/sessions/[id]/net-economics
//
// The LABOR side of one show's net-net figure: host pay, and the duration it was derived from.
// The product side (won/payout − COGS) is already on the client from the auction board, and the
// picking allocation comes from /api/team/fulfillment-cost-rate — which is shared across every
// show, so it is a separate endpoint the client caches once rather than recomputing per show.
//
// WHY HOST PAY IS COMPUTED HERE AND NOT ON THE CLIENT
// An individual's hourly_rate must not reach the browser. /api/live/sessions/[id] deliberately
// returns host_name without a rate, and adding one there would expose a single named employee's
// pay to anything that can read the session — a much worse leak than the aggregate figures
// /api/team/* returns, because it is attributable to a person. So the multiplication happens
// server-side and only the resulting cents leave. `host_rate_known` tells the client whether a
// blank means "no host mapped" or "host has no rate set", without revealing the rate itself.
//
// Owner-only, enforced upstream: '/api/live' is on no confinement allowlist
// (src/lib/supabase/claims.ts) and confinementFor() fails closed.
//
// HOST PAY = live duration × rate. Validated against the punch clock over 9 days — host punch
// hours 505.9 vs live-session hours 509.0 (0.6%), so this agrees with payroll rather than
// approximating it. The per-show caveat is short shows; see src/lib/shows/netEconomics.ts.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: session } = await supabase
    .from('live_sessions')
    .select('id, started_at, ended_at, host_id')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Most recent capture in the session window = end of active selling. Same query as
  // /duration; the shared resolveShowDuration() then applies the ended_at sanity rule.
  let q = supabase
    .from('capture_events')
    .select('created_at')
    .eq('user_id', user.id)
    .gte('created_at', session.started_at)
    .order('created_at', { ascending: false })
    .limit(1);
  if (session.ended_at) q = q.lte('created_at', session.ended_at);
  const { data: lastCap } = await q;
  const last_capture_at: string | null = lastCap?.[0]?.created_at ?? null;

  const { duration_ms, source } = resolveShowDuration({
    started_at: session.started_at,
    ended_at: session.ended_at,
    last_capture_at,
  });

  // Host pay. A session with no host_id (7% of the last 30 days), a host row that has since been
  // deleted, or a rate of 0/unset all yield null — NEVER 0 — so the client renders "—" and the
  // net-net card withholds a figure rather than printing one that omits a real cost.
  let host_name: string | null = null;
  let host_rate_known = false;
  let host_pay_cents: number | null = null;

  if (typeof session.host_id === 'string') {
    const { data: emp } = await supabase
      .from('employees')
      .select('name, hourly_rate')
      .eq('id', session.host_id)
      .maybeSingle();
    if (emp) {
      host_name = (emp.name as string | null) ?? null;
      const rate = Number(emp.hourly_rate) || 0;
      host_rate_known = rate > 0;
      if (rate > 0 && duration_ms != null && duration_ms > 0) {
        host_pay_cents = Math.round(rate * 100 * (duration_ms / 3_600_000));
      }
    }
  }

  return NextResponse.json({
    duration_ms,
    duration_source: source,
    host_id: session.host_id ?? null,
    host_name,
    host_rate_known,
    host_pay_cents,
  });
}
