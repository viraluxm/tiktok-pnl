import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { readAllPagedIn } from '@/lib/db/readAll';
import { readCandidates } from '@/lib/shipping/labelCandidates';
import { dayOf } from '@/lib/shipping/labelScope';
import { groupIntoBoxes, gateByAge } from '@/lib/shipping/candidateGate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/shipping/labels/scopes?store_id=…
//
// What a label run could be pointed at: recent fulfilment days, and the individual lives within
// them. Read-only, no TikTok calls — this feeds a dropdown, so it must be fast and must not
// spend API budget the run itself needs.
//
// COUNTS ARE BOXES, NOT ORDERS, because a box is what gets a label. Orders are shown too, since
// that is the number an operator recognises from Seller Center, but the two differ by roughly
// 3.5x here and conflating them would make every estimate wrong.
//
// "Ready" applies the same age floor the run applies, so a row reading 0 ready / 120 held is
// honest about a show that ended twenty minutes ago rather than advertising boxes that would
// then be refused.

/** How far back the picker offers. Beyond this, the backlog is not what anyone is printing. */
const LOOKBACK_DAYS = 10;

interface Sess {
  id: string;
  channel_nickname: string | null;
  channel_handle: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_seen_at: string | null;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });

  const admin = createAdminClient();
  const nowMs = Date.now();

  // Every candidate for this store, unscoped — the picker's job is to slice this up.
  const candidates = await readCandidates(admin, user.id, storeId, { kind: 'all' }, 'scopes');

  // Box-level readiness, computed once and reused for both groupings.
  const boxes = groupIntoBoxes(candidates);
  const readyByGroup = new Map<string, boolean>();
  for (const b of boxes) readyByGroup.set(b.group_key, gateByAge(b, nowMs).ok);

  // A box counts under EVERY fulfilment day it touches, not just its oldest order's day.
  //
  // This has to match how a run selects: the run takes any group with an order in the window and
  // then re-reads that group WHOLE, so a box straddling two nights is reachable from either. An
  // earlier version bucketed by oldest order only, and the picker advertised 531 boxes for a day
  // the run then resolved to 534 — the same box counted differently in two places.
  const daysOfBox = new Map<string, string[]>();
  for (const b of boxes) {
    const days = new Set<string>();
    for (const o of b.orders) {
      const t = o.order_created_at ? Date.parse(o.order_created_at) : NaN;
      if (Number.isFinite(t)) days.add(dayOf(t));
    }
    if (days.size) daysOfBox.set(b.group_key, [...days]);
  }

  type Bucket = { boxes: number; ready: number; orders: number };
  const bump = (m: Map<string, Bucket>, key: string, ready: boolean, orders: number) => {
    const b = m.get(key) ?? { boxes: 0, ready: 0, orders: 0 };
    b.boxes++; b.orders += orders; if (ready) b.ready++;
    m.set(key, b);
  };

  const byDay = new Map<string, Bucket>();
  for (const b of boxes) {
    for (const day of daysOfBox.get(b.group_key) ?? []) {
      bump(byDay, day, readyByGroup.get(b.group_key) ?? false, b.orders.length);
    }
  }

  // ── Which live each order came from. ──
  const orderIds = candidates.map((c) => c.order_id);
  const items = await readAllPagedIn<{ client_idempotency_key: string | null; session_id: string | null }, string>(
    orderIds,
    (chunk, from, to) => admin.from('live_auction_items')
      .select('client_idempotency_key, session_id')
      .eq('user_id', user.id).in('client_idempotency_key', chunk)
      .order('id', { ascending: true }).range(from, to),
    'labels scopes order sessions',
  );
  const sessionOfOrder = new Map<string, string>();
  for (const i of items) {
    const k = String(i.client_idempotency_key ?? '');
    const s = i.session_id ? String(i.session_id) : '';
    if (k && s && !sessionOfOrder.has(k)) sessionOfOrder.set(k, s);
  }

  // A box can straddle two shows when a combine group spans them. It is counted under each,
  // because either show is a legitimate way to reach it — the run itself de-duplicates.
  const bySession = new Map<string, Bucket>();
  for (const b of boxes) {
    const ready = readyByGroup.get(b.group_key) ?? false;
    const seen = new Set<string>();
    for (const o of b.orders) {
      const s = sessionOfOrder.get(o.order_id);
      if (s && !seen.has(s)) { seen.add(s); bump(bySession, s, ready, b.orders.length); }
    }
  }

  // ── Label the shows. ──
  const sessionIds = [...bySession.keys()];
  const sessions = await readAllPagedIn<Sess, string>(
    sessionIds,
    (chunk, from, to) => admin.from('live_sessions')
      .select('id, channel_nickname, channel_handle, started_at, ended_at, last_seen_at')
      .eq('user_id', user.id).in('id', chunk)
      .order('id', { ascending: true }).range(from, to),
    'labels scopes sessions',
  );
  const LIVE_WINDOW_MS = 20 * 60_000;

  const lives = sessions.map((s) => {
    const b = bySession.get(String(s.id)) ?? { boxes: 0, ready: 0, orders: 0 };
    const seen = s.last_seen_at ? Date.parse(s.last_seen_at) : NaN;
    return {
      id: String(s.id),
      // Titles are all the literal string "TikTok Live", so the channel is what actually
      // distinguishes a room. It is best-effort — channel attribution is known to mislabel on
      // multi-account machines — which is why the time window and counts are shown alongside.
      channel: s.channel_nickname || s.channel_handle || null,
      handle: s.channel_handle || null,
      started_at: s.started_at,
      ended_at: s.ended_at,
      running: Number.isFinite(seen) && nowMs - seen < LIVE_WINDOW_MS,
      day: s.started_at ? dayOf(Date.parse(s.started_at)) : null,
      boxes: b.boxes, ready: b.ready, orders: b.orders,
    };
  })
    .filter((l) => l.boxes > 0)
    .sort((a, z) => (Date.parse(z.started_at ?? '') || 0) - (Date.parse(a.started_at ?? '') || 0));

  const days = [...byDay.entries()]
    .map(([day, b]) => ({ day, ...b }))
    .sort((a, z) => (a.day < z.day ? 1 : -1))
    .slice(0, LOOKBACK_DAYS);

  return NextResponse.json({
    store_id: storeId,
    today: dayOf(nowMs),
    total_boxes: boxes.length,
    total_ready: [...readyByGroup.values()].filter(Boolean).length,
    days,
    lives,
  });
}
