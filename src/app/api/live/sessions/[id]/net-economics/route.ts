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
  //
  // PAID PER SEGMENT, NOT PER SESSION. live_sessions.host_id is a SCALAR that the extension
  // OVERWRITES on every host switch, so it names whoever hosted LAST. Charging rate × the whole
  // show against that one person is wrong twice over: it bills the closer for hours they did not
  // work, and it bills them at their rate for someone else's air time. On the 2026-09-09 show
  // that meant Ismael (1.05h of a 2.96h show) carried all of it and Samie carried none.
  //
  // Air time per host comes from pnl_show_host_segments — the same windows the board's host
  // band uses — so the band's minutes and the pay computed here cannot disagree. Rates are read
  // and multiplied SERVER-SIDE; only the resulting cents are returned, so no individual's
  // hourly_rate reaches the browser.
  type HostPay = {
    host_id: string | null; host_name: string | null;
    minutes: number; rate_known: boolean; pay_cents: number | null;
  };
  let hosts: HostPay[] = [];

  // rpc-grants: pnl_show_host_segments
  const { data: segRows, error: segErr } = await supabase.rpc('pnl_show_host_segments', { p_session_id: id });
  if (segErr) console.error('[net-economics] pnl_show_host_segments error (falling back to session scalar):', segErr);

  const segs = ((segRows ?? []) as Array<Record<string, unknown>>)
    .filter((r) => typeof r.host_id === 'string');

  if (segs.length) {
    const ids = [...new Set(segs.map((r) => String(r.host_id)))];
    const { data: emps } = await supabase
      .from('employees').select('id, name, hourly_rate').eq('user_id', user.id).in('id', ids);
    const empById = new Map((emps ?? []).map((e) => [String(e.id), e]));
    hosts = segs.map((r) => {
      const emp = empById.get(String(r.host_id));
      const minutes = Number(r.total_minutes ?? 0);
      const rate = Number(emp?.hourly_rate) || 0;
      return {
        host_id: String(r.host_id),
        host_name: (emp?.name as string | null) ?? (r.host_name as string | null) ?? null,
        minutes,
        rate_known: rate > 0,
        // null (never 0) when the rate is unknown, so the client withholds rather than
        // printing a net-net that quietly omits a real cost.
        pay_cents: rate > 0 && minutes > 0 ? Math.round(rate * 100 * (minutes / 60)) : null,
      };
    }).sort((a, b) => b.minutes - a.minutes);
  } else if (typeof session.host_id === 'string') {
    // FALLBACK: no segments for this show (pre-segment history, or 158/113 unavailable).
    // Preserve the previous whole-show behaviour so old shows do not start reading "—".
    const { data: emp } = await supabase
      .from('employees').select('name, hourly_rate').eq('id', session.host_id).maybeSingle();
    if (emp) {
      const rate = Number(emp.hourly_rate) || 0;
      hosts = [{
        host_id: session.host_id,
        host_name: (emp.name as string | null) ?? null,
        minutes: duration_ms != null ? duration_ms / 60_000 : 0,
        rate_known: rate > 0,
        pay_cents: rate > 0 && duration_ms != null && duration_ms > 0
          ? Math.round(rate * 100 * (duration_ms / 3_600_000)) : null,
      }];
    }
  }

  // Show-level totals. The headline host is the one with the MOST AIR TIME — not the last one
  // to hold the mic — matching how the Shows list labels the row.
  const lead = hosts[0] ?? null;
  // A single unpriced host makes the TOTAL unknowable, not smaller: null, never a partial sum.
  const anyUnpriced = hosts.some((h) => h.pay_cents == null);
  const host_pay_cents = hosts.length === 0 || anyUnpriced
    ? null
    : hosts.reduce((a, h) => a + (h.pay_cents ?? 0), 0);

  return NextResponse.json({
    duration_ms,
    duration_source: source,
    host_id: lead?.host_id ?? null,
    host_name: lead?.host_name ?? null,
    host_rate_known: lead?.rate_known ?? false,
    host_pay_cents,
    // Per-host breakdown, air-time descending. Drives the host band's filtered net-net.
    hosts,
  });
}
