import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// GET /api/fulfillment/kpis?range=today|7d|30d — org-wide worker KPIs (both stores).
// Break-aware: active-time = Σ[(shift end|now − start) − Σ breaks] (NOT wall-clock). Allowlist
// gated (current_store ∈ org_settings.kpi_dashboard_store_ids) → 403 otherwise (RLS is only
// org-member and wouldn't gate the view).
function rangeFrom(range: string): Date {
  const now = Date.now();
  if (range === '7d') return new Date(now - 7 * 86400000);
  if (range === '30d') return new Date(now - 30 * 86400000);
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; // today (UTC day start)
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Allowlist gate.
  const [{ data: cs }, { data: os }] = await Promise.all([
    supabase.rpc('current_store'),
    supabase.from('org_settings').select('kpi_dashboard_store_ids').eq('org_id', orgId).maybeSingle(),
  ]);
  const allow = (os?.kpi_dashboard_store_ids as string[] | undefined) ?? [];
  if (!cs || !allow.includes(cs as string)) return NextResponse.json({ error: 'NOT_ALLOWLISTED' }, { status: 403 });

  const range = new URL(req.url).searchParams.get('range') || 'today';
  const from = rangeFrom(range).toISOString();
  const nowMs = Date.now();

  const { data: shifts } = await supabase
    .from('fulfillment_shifts').select('id, worker_id, started_at, ended_at').eq('org_id', orgId).gte('started_at', from);
  const shiftIds = (shifts ?? []).map((s) => s.id as string);

  let breaks: Array<{ shift_id: string; started_at: string; ended_at: string | null }> = [];
  if (shiftIds.length) {
    const { data } = await supabase.from('fulfillment_shift_breaks').select('shift_id, started_at, ended_at').in('shift_id', shiftIds);
    breaks = (data as typeof breaks) ?? [];
  }
  const breaksByShift = new Map<string, typeof breaks>();
  for (const b of breaks) { const a = breaksByShift.get(b.shift_id) ?? []; a.push(b); breaksByShift.set(b.shift_id, a); }

  const [{ data: picks }, { data: packs }, { data: workers }] = await Promise.all([
    supabase.from('fulfillment_lines').select('picked_by').not('picked_by', 'is', null).gte('picked_at', from),
    supabase.from('fulfillment_orders').select('packed_by').not('packed_by', 'is', null).gte('packed_at', from),
    supabase.from('fulfillment_workers').select('id, name').eq('org_id', orgId),
  ]);
  const nameById = new Map((workers ?? []).map((w) => [w.id as string, w.name as string]));

  type Row = { worker_id: string; name: string; picks: number; packs: number; shifts: number; active_min: number; break_min: number };
  const rows = new Map<string, Row>();
  const ensure = (wid: string): Row => {
    let r = rows.get(wid);
    if (!r) { r = { worker_id: wid, name: nameById.get(wid) ?? '(unknown)', picks: 0, packs: 0, shifts: 0, active_min: 0, break_min: 0 }; rows.set(wid, r); }
    return r;
  };
  for (const s of shifts ?? []) {
    const r = ensure(s.worker_id as string); r.shifts += 1;
    const start = new Date(s.started_at as string).getTime();
    const end = s.ended_at ? new Date(s.ended_at as string).getTime() : nowMs;
    let brk = 0;
    for (const b of breaksByShift.get(s.id as string) ?? []) {
      const bs = new Date(b.started_at).getTime(); const be = b.ended_at ? new Date(b.ended_at).getTime() : nowMs;
      brk += Math.max(0, be - bs);
    }
    r.break_min += brk / 60000;
    r.active_min += Math.max(0, (end - start) - brk) / 60000;
  }
  for (const p of picks ?? []) ensure(p.picked_by as string).picks += 1;
  for (const p of packs ?? []) ensure(p.packed_by as string).packs += 1;

  const list = [...rows.values()]
    .map((r) => ({ ...r, active_min: Math.round(r.active_min), break_min: Math.round(r.break_min), items_per_hr: r.active_min > 0 ? Math.round(((r.picks + r.packs) / (r.active_min / 60)) * 10) / 10 : 0 }))
    .sort((a, b) => (b.picks + b.packs) - (a.picks + a.packs));
  const t = list.reduce((acc, r) => ({ picks: acc.picks + r.picks, packs: acc.packs + r.packs, shifts: acc.shifts + r.shifts, active_min: acc.active_min + r.active_min, break_min: acc.break_min + r.break_min }), { picks: 0, packs: 0, shifts: 0, active_min: 0, break_min: 0 });
  const totals = { ...t, items_per_hr: t.active_min > 0 ? Math.round(((t.picks + t.packs) / (t.active_min / 60)) * 10) / 10 : 0 };

  return NextResponse.json({ range, from, rows: list, totals });
}
