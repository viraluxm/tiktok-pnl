import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { getPackageDocument } from '@/lib/tiktok/client';
import {
  itemsFromLedger, itemsFromLedgerMerged, buildAssemblySequence, LEDGER_COLUMNS, type LedgerRow,
} from '@/lib/shipping/assemblyPlan';
import { BANNER_SINGLES, BANNER_MIXED, UNBOUND_CAPTION } from '@/lib/shipping/labelPlan';
import { addSlipPage, DEFAULT_SLIP_SIZE } from '@/lib/shipping/slipPage';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// GET /api/shipping/labels/pdf?store_id=…&run_id=…[&preview=1][&from=0&to=59]
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
//
// IT RETURNS A SLICE, NOT ALWAYS THE WHOLE STACK. A serverless response is capped at 4.5MB and
// a label page is roughly 55KB, so about 60 labels is the ceiling — measured: 1,400 labels
// assemble in 2.4s but produce a 96MB file, which cannot be returned at all. Buying a day's
// labels and then being unable to print them is the worst possible failure, so the route slices
// by `from`/`to` over the LABEL index and reports `parts` so a caller can fetch them all and
// stitch them together. Slicing on labels rather than pages keeps a label's own pages intact.
//
// Every slice carries the banners and slips for the sections it contains, so a part is
// self-describing even if the parts are printed separately.

/** Concurrent label downloads. Enough to be quick, few enough not to look like abuse. */
const FETCH_CONCURRENCY = 6;

/**
 * Labels per response.
 *
 * Vercel returns at most 4.5MB and a label page is around 55KB, so 60 leaves headroom for the
 * slips and banners that ride along with them. Measured against the real stack: 15 labels came
 * to ~1MB.
 */
const LABELS_PER_PART = 60;

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
  // store_id is OPTIONAL. Runs may span shops: labels are bought per shop because each has its
  // own TikTok connection, but the prep station packs by SKU and does not care which shop an
  // order came from. Omitting it prints the given runs together.
  const storeId = url.searchParams.get('store_id');
  const runParam = url.searchParams.get('run_id');
  const preview = url.searchParams.get('preview') === '1';
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
    .select(`${LEDGER_COLUMNS}, run_id`)
    .eq('user_id', user.id)
    .in('run_id', runIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let rows = (rowData ?? []) as Row[];
  // A store filter still applies when one is given, so single-shop printing is unchanged.
  if (storeId) rows = rows.filter((r) => String(r.store_id ?? '') === storeId);
  if (!rows.length) {
    return NextResponse.json({ error: 'No purchases found for that run', run_ids: runIds }, { status: 404 });
  }

  // ── One run keeps its own order; several are MERGED. ──
  //
  // A single run already prints in the order it was planned. Several runs are regrouped by SKU
  // across all of them, which is the whole point of printing shops together: 108 of 190 SKUs
  // sell in more than one shop, so per-shop stacks leave the same SKU in several piles and the
  // prep station walks it repeatedly.
  const merge = runIds.length > 1 && url.searchParams.get('merge') !== '0';
  const items = merge
    ? itemsFromLedgerMerged(rows, [BANNER_SINGLES, BANNER_MIXED, UNBOUND_CAPTION])
    : runIds.flatMap((rid) => itemsFromLedger(rows.filter((r) => r.run_id === rid)));
  const seq = buildAssemblySequence(items, rows);

  // ── Slice by label index. ──
  //
  // The window is over LABELS, not pages, so a label's pages are never split across parts. The
  // banner and slip that head a section are carried into whichever part holds its labels.
  const labelIdx: number[] = [];
  seq.pages.forEach((p, i) => { if (p.kind === 'label') labelIdx.push(i); });
  const totalLabels = labelIdx.length;
  const parts = Math.max(1, Math.ceil(totalLabels / LABELS_PER_PART));
  const fromRaw = Number(url.searchParams.get('from'));
  const toRaw = Number(url.searchParams.get('to'));
  const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0;
  const to = Number.isFinite(toRaw) && toRaw > 0
    ? Math.min(Math.floor(toRaw), totalLabels - 1)
    : totalLabels - 1;

  if (totalLabels && (from > 0 || to < totalLabels - 1)) {
    const firstPage = labelIdx[from] ?? 0;
    const lastPage = labelIdx[to] ?? seq.pages.length - 1;
    // Reach back for the section headers this slice sits under, so a part opens by saying what
    // it holds rather than starting mid-pile with an unlabelled label.
    const heads: typeof seq.pages = [];
    for (let i = firstPage - 1; i >= 0; i--) {
      if (seq.pages[i].kind === 'label') break;
      heads.unshift(seq.pages[i]);
    }
    seq.pages = [...heads, ...seq.pages.slice(firstPage, lastPage + 1)];
  }

  if (preview) {
    return NextResponse.json({
      run_ids: runIds,
      pages: seq.pages.length,
      labels: seq.labelCount,
      total_labels: totalLabels,
      labels_per_part: LABELS_PER_PART,
      parts,
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
    // ── Each label is refreshed with ITS OWN shop's token. ──
    //
    // A merged stack spans shops, and every shop is a separate TikTok connection: using one
    // shop's token to ask for another's document fails, and would have failed as a per-package
    // error that reads like a transient blip rather than a wiring mistake. Packages are grouped
    // by store and each group uses the credentials for that store.
    const storeOfPackage = new Map<string, string>();
    for (const r of rows) {
      if (r.package_id && r.store_id) storeOfPackage.set(String(r.package_id), String(r.store_id));
    }
    const byStore = new Map<string, string[]>();
    for (const packageId of seq.refetch) {
      const sid = storeOfPackage.get(packageId);
      if (!sid) continue;
      const arr = byStore.get(sid) ?? [];
      arr.push(packageId);
      byStore.set(sid, arr);
    }

    const failures: string[] = [];
    for (const [sid, packageIds] of byStore) {
      const { data: conn } = await admin
        .from('tiktok_connections').select('*')
        .eq('user_id', user.id).eq('store_id', sid).maybeSingle();
      if (!conn) {
        failures.push(`store ${sid} is not connected (${packageIds.length} labels)`);
        continue;
      }
      const fresh = await getFreshToken(admin, conn as ConnRow, { skewMinutes: 30 });
      const token = fresh.accessToken as string;
      const cipher = (fresh.shopCipher ?? (conn as { shop_cipher: string }).shop_cipher) as string;

      await pooled(packageIds, FETCH_CONCURRENCY, async (packageId) => {
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
            .eq('user_id', user.id).eq('store_id', sid).eq('package_id', packageId);

          // Write the tracking number where the PACK STATION reads it. Without this the
          // scanner cannot find a freshly bought label until the 30-minute sync cron catches
          // up, and someone has to remember to press "Fetch label tracking" first.
          if (doc.tracking_number) {
            const row = rows.find((r) => String(r.package_id) === packageId);
            for (const oid of row?.order_ids ?? []) {
              await admin.from('synced_order_ids')
                .update({ tracking_number: doc.tracking_number })
                .eq('user_id', user.id).eq('store_id', sid).eq('order_id', oid)
                .is('tracking_number', null);
            }
          }
        } catch (e) {
          failures.push(`${packageId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    }
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

  // ── Mark what was actually served as printed. ──
  //
  // After the bytes are built, so a failure earlier does not claim a stack was printed. Only
  // the labels IN THIS SLICE are marked: the stack is served in parts, and a download that
  // stops halfway has genuinely printed some and not others.
  //
  // `.is('printed_at', null)` keeps the FIRST print. Reprints are routine — a jam, a stack
  // split between stations — and must not read as new work.
  const servedPackages = seq.pages
    .filter((p): p is Extract<typeof p, { kind: 'label' }> => p.kind === 'label')
    .map((p) => p.package_id)
    .filter(Boolean);
  if (servedPackages.length) {
    const now = new Date().toISOString();
    for (let i = 0; i < servedPackages.length; i += 200) {
      await admin.from('shipping_label_purchases')
        .update({ printed_at: now })
        .eq('user_id', user.id)
        .in('package_id', servedPackages.slice(i, i + 200))
        .is('printed_at', null);
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="labels-${stamp}-${seq.labelCount}.pdf"`,
      'Cache-Control': 'no-store',
      // Surfaced in headers so a caller sees an incomplete stack without parsing the PDF.
      'X-Label-Count': String(seq.labelCount),
      // So a caller knows how many more slices to fetch without a second round trip.
      'X-Total-Labels': String(totalLabels),
      'X-Parts': String(parts),
      'X-Labels-Per-Part': String(LABELS_PER_PART),
      'X-Slip-Count': String(seq.slipCount),
      'X-Banner-Count': String(seq.bannerCount),
      'X-Missing-Count': String(seq.missing.length),
    },
  });
}
