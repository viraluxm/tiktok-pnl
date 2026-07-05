import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

// GET /api/fulfillment/queue — the "Orders to Complete" queue.
// ORG-SCOPED (shared warehouse): every non-shipped, non-exception box across BOTH stores,
// sorted by ship_by ascending (most-urgent / soonest dispatch deadline first), with the
// computed urgency tier, store label, line summary, and cubicle.

const ACTIVE = ['unpicked', 'picking', 'fully_picked', 'assigned', 'packing'];
// Tunable urgency thresholds (hours to ship_by).
const CRITICAL_H = 6, URGENT_H = 24, SOON_H = 48;

function urgency(shipByIso: string | null, nowMs: number): { tier: string; hours_left: number | null } {
  if (!shipByIso) return { tier: 'UNKNOWN', hours_left: null };
  const ms = new Date(shipByIso).getTime() - nowMs;
  const hours = ms / 3_600_000;
  let tier = 'OK';
  if (ms <= 0) tier = 'OVERDUE';
  else if (hours < CRITICAL_H) tier = 'CRITICAL';
  else if (hours < URGENT_H) tier = 'URGENT';
  else if (hours < SOON_H) tier = 'SOON';
  return { tier, hours_left: Math.round(hours * 10) / 10 };
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Boxes (org RLS returns both stores'). nulls (no SLA) sort last.
  const { data: boxes } = await supabase
    .from('fulfillment_orders')
    .select('id, group_key, order_ids, status, store_id, ship_by, ordered_at, cubicle_id, label_status, missing_order_ids')
    .in('status', ACTIVE)
    .order('ship_by', { ascending: true, nullsFirst: false });
  const rows = boxes ?? [];
  if (rows.length === 0) return NextResponse.json({ queue: [] });

  const foIds = rows.map((b) => b.id);
  const storeIds = [...new Set(rows.map((b) => b.store_id).filter(Boolean))] as string[];
  const cubicleIds = [...new Set(rows.map((b) => b.cubicle_id).filter(Boolean))] as string[];

  const [{ data: lines }, { data: stores }, { data: cubicles }] = await Promise.all([
    supabase.from('fulfillment_lines').select('fulfillment_order_id, inventory_sku_id, required_qty, picked').in('fulfillment_order_id', foIds),
    storeIds.length ? supabase.from('stores').select('id, name').in('id', storeIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    cubicleIds.length ? supabase.from('cubicles').select('id, cubicle_number').in('id', cubicleIds) : Promise.resolve({ data: [] as { id: string; cubicle_number: number }[] }),
  ]);

  const skuIds = [...new Set((lines ?? []).map((l) => String(l.inventory_sku_id)))];
  const { data: inv } = skuIds.length
    ? await supabase.from('inventory_skus').select('id, sku_number, title').eq('org_id', orgId).in('id', skuIds)
    : { data: [] as { id: string; sku_number: number; title: string }[] };

  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const cubNum = new Map((cubicles ?? []).map((c) => [c.id, c.cubicle_number]));
  const invById = new Map((inv ?? []).map((s) => [String(s.id), s]));
  const linesByFo = new Map<string, Array<{ sku_number: number | null; title: string; required_qty: number; picked: boolean }>>();
  for (const l of lines ?? []) {
    const s = invById.get(String(l.inventory_sku_id));
    const arr = linesByFo.get(l.fulfillment_order_id) ?? [];
    arr.push({ sku_number: s ? (s.sku_number as number) : null, title: s ? (s.title as string) : 'Unknown SKU', required_qty: l.required_qty as number, picked: l.picked as boolean });
    linesByFo.set(l.fulfillment_order_id, arr);
  }

  const now = Date.now();
  const queue = rows.map((b) => ({
    fulfillment_order_id: b.id,
    group_key: b.group_key,
    order_ids: b.order_ids,
    status: b.status,
    store: b.store_id ? (storeName.get(b.store_id) ?? 'Unknown store') : '—',
    ship_by: b.ship_by,
    ordered_at: b.ordered_at,
    label_status: b.label_status,
    cubicle_number: b.cubicle_id ? (cubNum.get(b.cubicle_id) ?? null) : null,
    unbound_count: ((b.missing_order_ids as string[]) ?? []).length,
    ...urgency(b.ship_by as string | null, now),
    lines: (linesByFo.get(b.id) ?? []).sort((a, z) => Number(a.sku_number ?? 0) - Number(z.sku_number ?? 0)),
  }));

  return NextResponse.json({ queue });
}
