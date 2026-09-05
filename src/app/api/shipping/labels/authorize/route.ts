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

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// POST   /api/shipping/labels/authorize?store_id=…&confirm_boxes=N[&day=|&session_ids=][&unbound=]
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
// DELETE releases an unbought manifest. Without it a mis-scoped authorisation would block those
// boxes from every future run until someone edited the table by hand.

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const confirmRaw = url.searchParams.get('confirm_boxes');
  const unboundRaw = url.searchParams.get('unbound');
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });

  const parsed = parseScope({
    day: url.searchParams.get('day'),
    sessionIds: url.searchParams.get('session_ids'),
  });
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const confirmBoxes = confirmRaw == null || confirmRaw.trim() === '' ? null : Number(confirmRaw);
  if (confirmBoxes != null && !Number.isInteger(confirmBoxes)) {
    return NextResponse.json({ error: 'confirm_boxes must be an integer' }, { status: 400 });
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
  const manifest: Array<{
    box: PlanBox; seq: number; banner: string | null; caption: string | null;
  }> = [];
  let banner: string | null = null;
  let caption: string | null = null;
  for (const page of planPageSequence(run.plan)) {
    if (page.kind === 'banner') { banner = page.caption; caption = null; continue; }
    if (page.kind === 'slip') { caption = page.caption; continue; }
    const b = byKey.get(page.group_key);
    if (b && !owned.has(b.group_key)) {
      manifest.push({ box: b, seq: manifest.length, banner, caption });
    }
  }

  const summary = {
    store_id: storeId,
    scope: run.scope,
    boxes: manifest.length,
    orders: manifest.reduce((n, m) => n + m.box.order_ids.length, 0),
    already_in_ledger: owned.size,
    unbound_boxes: run.unboundBoxes.length,
    unbound_policy: unboundPolicy,
    unbound_included: unboundPolicy === 'include',
    max_manifest_boxes: MAX_MANIFEST_BOXES,
    spend_estimate: await estimateSizedSpend(admin, user.id, storeId, manifest.map((m) => m.box.order_ids.length)),
    spend_recent: await readSpendWindows(admin, user.id, storeId),
  };

  const decision = authorizeRun({
    enabled: process.env.LABEL_PURCHASE_ENABLED === '1',
    boxes: manifest.length,
    confirmBoxes,
    unboundCount: run.unboundBoxes.length,
    unboundPolicy,
  });
  if (!decision.ok) {
    const status = decision.code === 'disabled' || decision.code === 'nothing_to_buy' ? 200 : 409;
    console.log(`[labels/authorize] refused (${decision.code}): ${decision.reason}`, summary);
    return NextResponse.json(
      { authorized: false, code: decision.code, reason: decision.reason, ...summary },
      { status },
    );
  }

  // ── Claim the whole manifest. Chunked because one insert of 800 rows is a large statement. ──
  const runId = randomUUID();
  const CHUNK = 200;
  let claimed = 0;
  for (let i = 0; i < manifest.length; i += CHUNK) {
    const rows = manifest.slice(i, i + CHUNK).map((m) => ({
      user_id: user.id, store_id: storeId, run_id: runId,
      group_key: m.box.group_key, order_ids: m.box.order_ids,
      status: 'claimed', ship_type: shipTypeFor(m.box),
      print_seq: m.seq, slip_caption: m.caption, banner_caption: m.banner,
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
