import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrgId } from '@/lib/org';
import { resolveAndUpsertBox } from '@/lib/fulfillment/box';
import { decryptOrFallback } from '@/lib/crypto';
import { getOrderById } from '@/lib/tiktok/client';

export const dynamic = 'force-dynamic';

// POST { sessionId, orderIds } — "Buy labels" entry point.
//
// STUB MODE (safe test path): finalize package grouping + capture the dispatch SLA, and
// CREATE the boxes/slips that the queue consumes. Per box we fetch getOrderById to record
// ship_by = min(rts_sla_time) (late-dispatch deadline) and ordered_at = min(create_time).
// Does NOT call TikTok's real label-purchase or ship API — no money spent, nothing shipped.
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await getOrgId(supabase, user.id);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { sessionId?: string; orderIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter((x): x is string => typeof x === 'string') : [];
  if (!sessionId || orderIds.length === 0) return NextResponse.json({ error: 'Select a session and at least one order' }, { status: 400 });

  // Session must be ours (sessions stay owner-private).
  const { data: session } = await supabase
    .from('live_sessions').select('id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Our connection (for the SLA lookup — these orders are ours).
  const { data: conn } = await supabase
    .from('tiktok_connections').select('access_token, shop_cipher').eq('user_id', user.id).maybeSingle();
  const token = conn?.access_token ? decryptOrFallback(conn.access_token, 'access_token') : null;
  const cipher = conn?.shop_cipher ?? null;

  // Dedupe selected orders into BOXES by auto_combine_group_id (one box per group).
  const { data: rows } = await supabase
    .from('synced_order_ids').select('order_id, auto_combine_group_id')
    .eq('user_id', user.id).in('order_id', orderIds);
  const anchorByGroup = new Map<string, string>();
  for (const r of rows ?? []) {
    const oid = String(r.order_id);
    const key = r.auto_combine_group_id ? String(r.auto_combine_group_id) : `order:${oid}`;
    if (!anchorByGroup.has(key)) anchorByGroup.set(key, oid);
  }

  const created: Array<{ group_key: string; fulfillment_order_id: string; lines: number; missing: number; ship_by: string | null }> = [];
  const failed: Array<{ anchor: string; error: string }> = [];

  for (const anchor of anchorByGroup.values()) {
    const out = await resolveAndUpsertBox(supabase, user.id, orgId, anchor, 'unpicked');
    if (!out.ok) { failed.push({ anchor, error: out.error }); continue; }

    // Capture dispatch SLA from TikTok (stub "buy" = finalize grouping + record deadline).
    let shipBy: string | null = null;
    let orderedAt: string | null = null;
    if (token && cipher) {
      try {
        const orders = await getOrderById(token, cipher, out.box.order_ids.slice(0, 50));
        const rts = orders.map((o) => toNum(o.rts_sla_time)).filter((n) => n > 0);
        const cts = orders.map((o) => toNum(o.create_time)).filter((n) => n > 0);
        if (rts.length) shipBy = new Date(Math.min(...rts) * 1000).toISOString();
        if (cts.length) orderedAt = new Date(Math.min(...cts) * 1000).toISOString();
      } catch { /* SLA fetch best-effort; box still created */ }
    }

    await supabase.from('fulfillment_orders').update({
      ship_by: shipBy,
      ordered_at: orderedAt,
      label_status: 'stub',          // STUB: no real label purchased
      labels_purchased_at: new Date().toISOString(),
    }).eq('id', out.box.fulfillment_order_id);

    created.push({ group_key: out.box.group_key, fulfillment_order_id: out.box.fulfillment_order_id, lines: out.box.lines.length, missing: out.box.missing_order_ids.length, ship_by: shipBy });
  }

  return NextResponse.json({
    ok: true,
    mode: 'stub',
    boxes_created: created.length,
    orders_selected: orderIds.length,
    boxes: created,
    failed,
    note: 'STUB: boxes created with dispatch SLA captured. No real TikTok label purchased, nothing shipped.',
  });
}
