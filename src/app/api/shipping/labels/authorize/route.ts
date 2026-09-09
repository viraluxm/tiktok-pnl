import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { planPageSequence, type PlanBox } from '@/lib/shipping/labelPlan';
import { resolveLabelRun, shipTypeFor, VerifyFailedError } from '@/lib/shipping/labelRun';
import { parseScope } from '@/lib/shipping/labelScope';
import {
  authorizeRun, estimateSizedSpend, readSpendWindows, MAX_MANIFEST_BOXES, type UnboundPolicy,
} from '@/lib/shipping/purchaseGuards';

/**
 * Ceiling on the reviewed set, well clear of MAX_MANIFEST_BOXES so the cap refusal is what a
 * too-large run hits, not a parse error. Guards only against an absurd body.
 */
const MAX_REVIEWED_KEYS = 20_000;

export const dynamic = 'force-dynamic';
// Verification of a 3,000-box manifest is ~10,000 orders, or 200 concurrent calls at roughly
// 16s per 100 — plus the candidate and SKU reads and 15 chunked inserts. 120s was cutting it
// close enough to truncate; the ceiling is the most this platform allows.
export const maxDuration = 300;

// POST   /api/shipping/labels/authorize?store_id=…[&day=|&session_ids=][&unbound=]
//        body: { "reviewed_keys": ["<group_key>", …] }
// DELETE /api/shipping/labels/authorize?store_id=…&run_id=…
//
// AUTHORISE A MANIFEST. Resolves the scope, verifies it against TikTok, and writes every box to
// the ledger as a `claimed` row. BUYS NOTHING.
//
// WHY THIS IS A SEPARATE STEP FROM BUYING. A fulfilment day is 474-863 boxes and each label is
// its own TikTok call, so a day takes about ten minutes — far past any single request. The work
// therefore has to be chunked, but the APPROVAL must not be: re-confirming between chunks is
// exactly the "multiple batches" this was asked not to do. So approval happens once, here, and
// produces a manifest the purchase route drains mechanically with no further judgement.
//
// The claimed rows ARE the manifest. That reuses the ledger's existing double-buy guard — one
// live claim per box, enforced by a partial unique index — so a manifest cannot overlap another
// one, and a crash mid-drain leaves a resumable run rather than an unknown state.
//
// WHAT IS APPROVED IS A SET OF BOXES, sent as `reviewed_keys` in the body rather than a count in
// the query string — 1,324 keys is ~35KB, past what a URL carries. Only keys that were reviewed
// AND still resolve are claimed, so a box that appeared since the check is never bought and the
// spend cannot exceed what was read. It is in the body for size, not for secrecy.
//
// DELETE releases an unbought manifest. Without it a mis-scoped authorisation would block those
// boxes from every future run until someone edited the table by hand.

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const unboundRaw = url.searchParams.get('unbound');
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });

  const parsed = parseScope({
    day: url.searchParams.get('day'),
    sessionIds: url.searchParams.get('session_ids'),
  });
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // The reviewed set. A missing or unparseable body leaves this null, which authorizeRun refuses
  // as `confirm_missing` — the same answer a stale cached client gets, and a safe one: it buys
  // nothing and tells the operator to re-check.
  let reviewedKeys: string[] | null = null;
  try {
    const body = (await req.json()) as { reviewed_keys?: unknown } | null;
    const raw = body?.reviewed_keys;
    if (Array.isArray(raw)) {
      if (raw.length > MAX_REVIEWED_KEYS) {
        return NextResponse.json(
          { error: `reviewed_keys holds ${raw.length} entries, over the ${MAX_REVIEWED_KEYS} ceiling` },
          { status: 400 },
        );
      }
      if (!raw.every((k) => typeof k === 'string')) {
        return NextResponse.json({ error: 'reviewed_keys must be an array of strings' }, { status: 400 });
      }
      reviewedKeys = raw as string[];
    } else if (raw !== undefined) {
      return NextResponse.json({ error: 'reviewed_keys must be an array of strings' }, { status: 400 });
    }
  } catch {
    // No body, or not JSON. Treated as "nothing reviewed".
  }

  if (unboundRaw != null && unboundRaw !== 'skip' && unboundRaw !== 'include') {
    return NextResponse.json({ error: "unbound must be 'skip' or 'include'" }, { status: 400 });
  }
  const unboundPolicy = (unboundRaw ?? null) as UnboundPolicy | null;

  const admin = createAdminClient();
  const { data: conn } = await admin
    .from('tiktok_connections').select('*')
    .eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
  if (!conn) return NextResponse.json({ error: 'Store not connected' }, { status: 404 });

  const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });

  let run;
  try {
    run = await resolveLabelRun(admin, {
      userId: user.id, storeId,
      accessToken: fresh.accessToken as string,
      shopCipher: (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string,
      tag: 'authorize',
      scope: parsed.scope,
      includeUnbound: unboundPolicy === 'include',
    });
  } catch (e) {
    if (e instanceof VerifyFailedError) {
      return NextResponse.json(
        { error: `Could not verify order statuses with TikTok: ${e.message}`, verified: false },
        { status: 502 },
      );
    }
    throw e;
  }

  // Drop anything the ledger already owns, so a re-authorisation after a partial drain covers
  // only what is left rather than colliding with its own earlier claims.
  const { data: ledger } = await admin
    .from('shipping_label_purchases')
    .select('group_key')
    .eq('user_id', user.id).eq('store_id', storeId)
    .neq('status', 'failed')
    .in('group_key', run.boxes.map((b) => b.group_key));
  const owned = new Set((ledger ?? []).map((r: { group_key: string }) => r.group_key));

  // Walk the print sequence so print_seq and both caption levels are recorded in the order the
  // stack will actually be assembled — the plan cannot be re-derived once orders advance.
  const byKey = new Map(run.boxes.map((b) => [b.group_key, b]));
  type Entry = { box: PlanBox; banner: string | null; caption: string | null };
  const resolvedManifest: Entry[] = [];
  let banner: string | null = null;
  let caption: string | null = null;
  for (const page of planPageSequence(run.plan)) {
    if (page.kind === 'banner') { banner = page.caption; caption = null; continue; }
    if (page.kind === 'slip') { caption = page.caption; continue; }
    const b = byKey.get(page.group_key);
    if (b && !owned.has(b.group_key)) {
      resolvedManifest.push({ box: b, banner, caption });
    }
  }

  const buildSummary = async (entries: Entry[], extra: Record<string, unknown>) => ({
    store_id: storeId,
    scope: run.scope,
    boxes: entries.length,
    orders: entries.reduce((n, m) => n + m.box.order_ids.length, 0),
    reviewed_boxes: reviewedKeys?.length ?? 0,
    resolved_boxes: resolvedManifest.length,
    already_in_ledger: owned.size,
    unbound_boxes: run.unboundBoxes.length,
    unbound_policy: unboundPolicy,
    unbound_included: unboundPolicy === 'include',
    max_manifest_boxes: MAX_MANIFEST_BOXES,
    spend_estimate: await estimateSizedSpend(admin, user.id, storeId, entries.map((m) => m.box.order_ids.length)),
    spend_recent: await readSpendWindows(admin, user.id, storeId),
    ...extra,
  });

  const decision = authorizeRun({
    enabled: process.env.LABEL_PURCHASE_ENABLED === '1',
    resolvedKeys: resolvedManifest.map((m) => m.box.group_key),
    reviewedKeys,
    unboundCount: run.unboundBoxes.length,
    unboundPolicy,
  });
  if (!decision.ok) {
    const status = decision.code === 'disabled' || decision.code === 'nothing_to_buy' ? 200 : 409;
    const summary = await buildSummary(resolvedManifest, {});
    console.log(`[labels/authorize] refused (${decision.code}): ${decision.reason}`, summary);
    return NextResponse.json(
      { authorized: false, code: decision.code, reason: decision.reason, ...summary },
      { status },
    );
  }

  // ONLY the boxes that were reviewed AND still resolve. Print order and captions come from the
  // current plan walk above, so the sequence describes the stack that will really be assembled;
  // membership comes from the review, so nothing unread is bought.
  const buyable = new Set(decision.buy);
  const manifest = resolvedManifest.filter((m) => buyable.has(m.box.group_key));
  const summary = await buildSummary(manifest, {
    dropped_since_review: decision.dropped,
    added_since_review: decision.added,
  });

  // ── Claim the whole manifest. Chunked because one insert of 800 rows is a large statement. ──
  const runId = randomUUID();
  const CHUNK = 200;
  let claimed = 0;
  for (let i = 0; i < manifest.length; i += CHUNK) {
    const rows = manifest.slice(i, i + CHUNK).map((m, j) => ({
      user_id: user.id, store_id: storeId, run_id: runId,
      group_key: m.box.group_key, order_ids: m.box.order_ids,
      status: 'claimed', ship_type: shipTypeFor(m.box),
      // Contiguous over the FILTERED manifest — print_seq numbers the stack being bought, not
      // the wider set that resolved.
      print_seq: i + j, slip_caption: m.caption, banner_caption: m.banner,
      run_scope: run.scope,
    }));
    const { error } = await admin.from('shipping_label_purchases').insert(rows);
    if (error) {
      // A conflict means another run claimed one of these boxes between the read above and now.
      // The partially-written manifest is left in place and returned: it is valid, drainable,
      // and deleting it would race the same way. The caller re-authorises for the remainder.
      console.error(`[labels/authorize] claim chunk failed at ${i}: ${error.message}`);
      return NextResponse.json({
        authorized: claimed > 0, run_id: runId, claimed, partial: true,
        error: `Claimed ${claimed} of ${manifest.length} before a conflict: ${error.message}`,
        ...summary,
      }, { status: claimed > 0 ? 207 : 409 });
    }
    claimed += rows.length;
  }

  console.log(`[labels/authorize] run ${runId}: claimed ${claimed} boxes (${run.scope})`);
  return NextResponse.json({ authorized: true, run_id: runId, claimed, ...summary });
}

/** Release an unbought manifest. Purchased rows are never touched. */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const runId = url.searchParams.get('run_id');
  if (!storeId || !runId) {
    return NextResponse.json({ error: 'store_id and run_id are required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('shipping_label_purchases')
    .delete()
    .eq('user_id', user.id).eq('store_id', storeId).eq('run_id', runId)
    .eq('status', 'claimed')          // never a purchased row: that label exists and was paid for
    .select('group_key');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ released: (data ?? []).length, run_id: runId });
}
