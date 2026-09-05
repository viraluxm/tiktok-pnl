import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { readAllPaged } from '@/lib/db/readAll';
import { BANNER_SINGLES, BANNER_MIXED, UNBOUND_CAPTION } from '@/lib/shipping/labelPlan';

export const dynamic = 'force-dynamic';

// GET /api/shipping/labels/runs?store_id=…[&limit=20]
//
// Past label runs for a shop, newest first, so a stack can be found and reprinted.
//
// WHY REPRINTING MATTERS ENOUGH TO BUILD THIS. A printed stack is consumable — jammed, split
// across stations, half-packed and set down. The labels are already paid for, so the only thing
// standing between a lost stack and a reprint is knowing which run it was. Without a history
// that means reading run_ids out of the database.
//
// It is also the honest record of spend: what was bought, when, for which night, and what it
// cost. Reads only; buys nothing and changes nothing.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface Row {
  run_id: string;
  run_scope: string | null;
  status: string;
  price_amount: number | string | null;
  purchased_at: string | null;
  created_at: string | null;
  banner_caption: string | null;
  package_id: string | null;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));

  const admin = createAdminClient();

  // Paged: a busy month is well past PostgREST's silent 1000-row cap, and a truncated read here
  // would quietly drop older runs from the history — the exact runs someone is looking for.
  const rows = await readAllPaged<Row>(
    (from, to) => admin.from('shipping_label_purchases')
      .select('run_id, run_scope, status, price_amount, purchased_at, created_at, banner_caption, package_id')
      .eq('user_id', user.id).eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .order('run_id', { ascending: true })
      .range(from, to),
    'label runs history',
  );

  const byRun = new Map<string, {
    run_id: string; scope: string | null;
    labels: number; purchased: number; claimed: number; failed: number;
    singles: number; mixed: number; unbound: number; other: number;
    spent: number; printable: number;
    at: string | null;
  }>();

  for (const r of rows) {
    const id = String(r.run_id);
    const e = byRun.get(id) ?? {
      run_id: id, scope: r.run_scope ?? null,
      labels: 0, purchased: 0, claimed: 0, failed: 0,
      singles: 0, mixed: 0, unbound: 0, other: 0, spent: 0, printable: 0,
      at: null,
    };
    e.labels++;
    if (r.status === 'purchased') e.purchased++;
    else if (r.status === 'claimed') e.claimed++;
    else if (r.status === 'failed') e.failed++;

    const p = Number(r.price_amount);
    if (Number.isFinite(p) && p > 0) e.spent += p;
    // Only a purchased box with a package_id of ours can be fetched and printed.
    if (r.status === 'purchased' && r.package_id) e.printable++;

    // Compared against the constants, never a text prefix. An earlier version matched
    // startsWith('MIXED') and silently counted zero once the banner was reworded to "BUNDLED
    // ORDERS — PICK REGULAR" — a classification that breaks when the wording changes is worse
    // than none, because it reports a confident 0 rather than an obvious gap.
    const b = r.banner_caption ?? '';
    if (b === BANNER_SINGLES) e.singles++;
    else if (b === BANNER_MIXED) e.mixed++;
    else if (b === UNBOUND_CAPTION) e.unbound++;
    else if (b) e.other++;

    // The run's timestamp is when it was first written, not when its last label landed: a run is
    // one act even though its purchases trickle in over ten minutes.
    const t = r.purchased_at ?? r.created_at;
    if (t && (!e.at || t < e.at)) e.at = t;
    if (!e.scope && r.run_scope) e.scope = r.run_scope;
    byRun.set(id, e);
  }

  const runs = [...byRun.values()]
    .map((r) => ({ ...r, spent: Math.round(r.spent * 100) / 100 }))
    .sort((a, b) => (a.at && b.at ? (a.at < b.at ? 1 : -1) : 0))
    .slice(0, limit);

  return NextResponse.json({
    store_id: storeId,
    runs,
    total_runs: byRun.size,
    // Lifetime spend for this shop, from the same rows — no second read to disagree with.
    total_spent: Math.round(
      [...byRun.values()].reduce((n, r) => n + r.spent, 0) * 100,
    ) / 100,
  });
}
