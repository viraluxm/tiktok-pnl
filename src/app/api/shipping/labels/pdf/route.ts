import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { getPackageDocument } from '@/lib/tiktok/client';
import {
  itemsFromLedger, buildAssemblySequence, type LedgerRow,
} from '@/lib/shipping/assemblyPlan';
import { addSlipPage, DEFAULT_SLIP_SIZE } from '@/lib/shipping/slipPage';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// GET /api/shipping/labels/pdf?store_id=…&run_id=…[&preview=1]
//
// The printable stack for a purchase run: a separator slip, then that SKU's labels, repeating,
// with bundles last. Returns one PDF sized to the labels themselves.
//
// IT READS ONLY THE LEDGER. The print order cannot be re-derived from live data — buying a
// label advances its order out of the candidate set, and SKU batching depends on the whole
// set, so re-planning later would produce a different stack from the one that was reviewed.
// Each row therefore carries its own print position and section caption (migration 125), which
// also means a run bought last week reprints identically.
//
// BUYS NOTHING. Its only write is refreshing an expired doc_url, which costs nothing: the label
// is already paid for and TikTok will re-issue its URL for the same package_id indefinitely.
//
// `preview=1` returns the sequence as JSON instead of a PDF — the same resolution, no
// downloads, for checking what a stack will contain before sending it to a printer.

/** Concurrent label downloads. Enough to be quick, few enough not to look like abuse. */
const FETCH_CONCURRENCY = 6;

type Row = LedgerRow & { run_id: string };

/** Run `work` over `items` at most `n` at a time, preserving nothing but completion. */
async function pooled<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await work(items[idx]);
    }
  }));
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const storeId = url.searchParams.get('store_id');
  const runParam = url.searchParams.get('run_id');
  const preview = url.searchParams.get('preview') === '1';
  if (!storeId) return NextResponse.json({ error: 'store_id is required' }, { status: 400 });
  if (!runParam) return NextResponse.json({ error: 'run_id is required' }, { status: 400 });

  // Several runs may be printed as one stack — a limited purchase run produces several. Each
  // run stays a contiguous block in the order given, so a stack always matches a review.
  const runIds = runParam.split(',').map((s) => s.trim()).filter(Boolean);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!runIds.length || runIds.some((r) => !UUID.test(r))) {
    return NextResponse.json({ error: 'run_id must be one or more comma-separated UUIDs' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: rowData, error } = await admin
    .from('shipping_label_purchases')
    .select('group_key, status, package_id, doc_url, doc_url_expires_at, tracking_number, print_seq, slip_caption, run_id')
    .eq('user_id', user.id).eq('store_id', storeId)
    .in('run_id', runIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (rowData ?? []) as Row[];
  if (!rows.length) {
    return NextResponse.json({ error: 'No purchases found for that run', run_ids: runIds }, { status: 404 });
  }

  // Resolve run by run, so each purchase run is a contiguous block in the printed order.
  const items = runIds.flatMap((rid) => itemsFromLedger(rows.filter((r) => r.run_id === rid)));
  const seq = buildAssemblySequence(items, rows);

  if (preview) {
    return NextResponse.json({
      run_ids: runIds,
      pages: seq.pages.length,
      labels: seq.labelCount,
      slips: seq.slipCount,
      banners: seq.bannerCount,
      needs_refetch: seq.refetch.length,
      missing: seq.missing,
      sequence: seq.pages.map((p) => (p.kind === 'label'
        ? { kind: 'label', group_key: p.group_key }
        : { kind: p.kind, caption: p.caption, count: p.count })),
    });
  }

  if (!seq.labelCount) {
    return NextResponse.json(
      { error: 'Nothing printable in that run', missing: seq.missing },
      { status: 409 },
    );
  }

  // ── Refresh any expired document URLs. ──
  //
  // Free: the label is bought, and TikTok re-issues a URL for the same package_id. Only the
  // ones actually needed are fetched, and a failure here is fatal for that page rather than
  // silently producing a stack with a hole in it.
  const freshUrls = new Map<string, string>();
  if (seq.refetch.length) {
    const { data: conn } = await admin
      .from('tiktok_connections').select('*')
      .eq('user_id', user.id).eq('store_id', storeId).maybeSingle();
    if (!conn) return NextResponse.json({ error: 'Store not connected' }, { status: 404 });
    const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });
    const token = fresh.accessToken as string;
    const cipher = (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string;

    const failures: string[] = [];
    await pooled(seq.refetch, FETCH_CONCURRENCY, async (packageId) => {
      try {
        const doc = await getPackageDocument(token, cipher, packageId);
        if (!doc.doc_url) { failures.push(packageId); return; }
        freshUrls.set(packageId, doc.doc_url);
        await admin.from('shipping_label_purchases')
          .update({
            doc_url: doc.doc_url,
            doc_url_expires_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
            tracking_number: doc.tracking_number, doc_error: null,
          })
          .eq('user_id', user.id).eq('store_id', storeId).eq('package_id', packageId);
      } catch (e) {
        failures.push(`${packageId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    if (failures.length) {
      return NextResponse.json(
        {
          error: 'Could not refresh some label documents — refusing to print a stack with gaps',
          failures: failures.slice(0, 20),
        },
        { status: 502 },
      );
    }
  }

  // ── Download the label PDFs. ──
  const bytesByPackage = new Map<string, Uint8Array>();
  const downloadFailures: string[] = [];
  const labels = seq.pages.filter((p) => p.kind === 'label') as Array<
    Extract<(typeof seq.pages)[number], { kind: 'label' }>
  >;
  await pooled(labels, FETCH_CONCURRENCY, async (label) => {
    const href = label.doc_url ?? freshUrls.get(label.package_id);
    if (!href) { downloadFailures.push(`${label.group_key}: no document url`); return; }
    try {
      const res = await fetch(href);
      if (!res.ok) { downloadFailures.push(`${label.group_key}: HTTP ${res.status}`); return; }
      bytesByPackage.set(label.package_id, new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      downloadFailures.push(`${label.group_key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  // A missing page would be indistinguishable from a short run once the stack is printed, and
  // the packer would ship one parcel unlabelled. Refuse the whole document instead.
  if (downloadFailures.length) {
    return NextResponse.json(
      {
        error: 'Could not download some labels — refusing to print a stack with gaps',
        failures: downloadFailures.slice(0, 20),
      },
      { status: 502 },
    );
  }

  // ── Assemble. ──
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);

  // Match the slips to the labels' own page size so the printer never rescales mid-document —
  // a rescale would resize the label pages too, and a shrunk barcode may not scan.
  let pageSize = DEFAULT_SLIP_SIZE;
  const firstBytes = bytesByPackage.get(labels[0].package_id);
  if (firstBytes) {
    try {
      const probe = await PDFDocument.load(firstBytes);
      const p0 = probe.getPages()[0];
      if (p0) pageSize = { width: p0.getWidth(), height: p0.getHeight() };
    } catch { /* keep the 4x6 default */ }
  }

  for (const page of seq.pages) {
    if (page.kind === 'banner' || page.kind === 'slip') {
      // A banner is drawn heavier than a slip: it is the divider someone finds while splitting
      // the stack by hand, often without reading it closely.
      addSlipPage(out, font, pageSize, {
        caption: page.caption, count: page.count, banner: page.kind === 'banner',
      });
      continue;
    }
    const bytes = bytesByPackage.get(page.package_id);
    if (!bytes) {
      return NextResponse.json(
        { error: `Label bytes missing for ${page.group_key} — refusing to print a partial stack` },
        { status: 500 },
      );
    }
    // Copy the label's pages VERBATIM. Never scale or redraw them: the barcode is the point,
    // and TikTok's own rendering is what the carrier accepts.
    const src = await PDFDocument.load(bytes);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
  }

  const pdf = await out.save();
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="labels-${stamp}-${seq.labelCount}.pdf"`,
      'Cache-Control': 'no-store',
      // Surfaced in headers so a caller sees an incomplete stack without parsing the PDF.
      'X-Label-Count': String(seq.labelCount),
      'X-Slip-Count': String(seq.slipCount),
      'X-Banner-Count': String(seq.bannerCount),
      'X-Missing-Count': String(seq.missing.length),
    },
  });
}
