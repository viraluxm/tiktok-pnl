import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrderById, getShippingDocument } from '@/lib/tiktok/client';
import { getFreshToken, type ConnRow } from '@/lib/tiktok/tokens';
import { PDFDocument } from 'pdf-lib';
import {
  embedFonts, addLabelPage, addSlipPage, addErrorSheet, PAGE, PAIR_ORDER, A6_FIT, type SlipModel,
} from '@/lib/shipping/composePairs';
import { classifyOrders, aggregateBox, type BoxOrderRow } from '@/lib/shipping/boxCompose';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST: OUR batch print — for each included box a strict pair of 4x6 pages (TikTok shipping label,
// then our order-id Code128 + count slip). Reads our DB (age filter + box-level catalog exclusion),
// resolves boxes TRACKING-FIRST (a box = one physical package), fetches the label fresh at print
// time, and reconciles the DB box against the fetched package_id — disagreement / no reliable key →
// the slip prints UNVERIFIABLE instead of a confident count. Bounded/resumable: ~BOX_BUDGET boxes
// per invocation, keyset by representative order_id, returns { processed, remaining, next_after }.
// No writes, no label purchase.

const BOX_BUDGET_DEFAULT = 60;   // ~60 boxes × ~2-3s (getOrderById batched + label fetch + PDF) < 240s
const TIME_BUDGET_MS = 240_000;
const DOC_RETRY = 2;             // transient "still being generated" backoff attempts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row extends BoxOrderRow {
  auto_combine_group_id: string | null; tracking_number: string | null; store_id: string | null; order_created_at: string | null;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uid = user.id;

  const body = await req.json().catch(() => ({})) as { store_id?: string; days?: number | 'all'; box_budget?: number; after?: string };
  const storeId = typeof body.store_id === 'string' ? body.store_id.trim() : '';
  const allDays = body.days === 'all';
  const days = allDays ? null : (Number.isFinite(Number(body.days)) && Number(body.days) > 0 ? Number(body.days) : 3);
  const cutoffMs = allDays ? null : Date.now() - (days as number) * 86_400_000;
  const boxBudget = Math.max(1, Math.trunc(Number(body.box_budget) || BOX_BUDGET_DEFAULT));
  const after = typeof body.after === 'string' ? body.after : '';
  const started = Date.now();

  // 1) Load AWAITING_COLLECTION orders (paged).
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('synced_order_ids')
      .select('order_id, auto_combine_group_id, tracking_number, store_id, order_created_at, tiktok_product_id, sku_name, units')
      .eq('user_id', uid).eq('status', 'AWAITING_COLLECTION').order('order_id', { ascending: true }).range(from, from + 999);
    if (storeId) q = q.eq('store_id', storeId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: `load failed: ${error.message}` }, { status: 500 });
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }

  // 2) Group into boxes TRACKING-FIRST (null-tracking → combine-group fallback). One box = one parcel.
  const grpTrk = new Map<string, Set<string>>();
  for (const r of rows) if (r.auto_combine_group_id && r.tracking_number) {
    const k = `${r.store_id}|${r.auto_combine_group_id}`; (grpTrk.get(k) ?? grpTrk.set(k, new Set()).get(k)!).add(r.tracking_number);
  }
  const boxKey = (r: Row): string => {
    if (r.tracking_number) return `trk:${r.store_id}:${r.tracking_number}`;
    if (r.auto_combine_group_id) { const t = grpTrk.get(`${r.store_id}|${r.auto_combine_group_id}`); if (t && t.size === 1) return `trk:${r.store_id}:${[...t][0]}`; return `grp:${r.store_id}:${r.auto_combine_group_id}`; }
    return `order:${r.order_id}`;
  };
  const boxes = new Map<string, Row[]>();
  for (const r of rows) { const k = boxKey(r); (boxes.get(k) ?? boxes.set(k, []).get(k)!).push(r); }

  // 3) Classify once; per-box age filter (any order in window) + box-level catalog exclusion.
  const cls = await classifyOrders(supabase, uid, rows);
  interface Box { key: string; rep: string; storeId: string | null; hasTracking: boolean; tracking: string | null; orderIds: string[]; counts: ReturnType<typeof aggregateBox> }
  const included: Box[] = [];
  let excludedCatalog = 0;
  for (const [key, brs] of boxes) {
    const inWindow = cutoffMs === null || brs.some((r) => r.order_created_at != null && new Date(r.order_created_at).getTime() >= cutoffMs);
    if (!inWindow) continue;
    const orderIds = brs.map((r) => r.order_id);
    const counts = aggregateBox(orderIds, cls);
    if (counts.allCatalog) { excludedCatalog++; continue; } // exclude ONLY entirely-catalog boxes
    included.push({
      key, rep: orderIds.slice().sort()[0], storeId: brs[0].store_id, hasTracking: key.startsWith('trk:'),
      tracking: brs.find((r) => r.tracking_number)?.tracking_number ?? null, orderIds, counts,
    });
  }
  included.sort((a, b) => a.rep.localeCompare(b.rep));
  const totalIncluded = included.length;

  // 4) Keyset chunk: boxes with rep > after, up to the budget.
  const queue = included.filter((b) => b.rep > after).slice(0, boxBudget);

  const admin = createAdminClient();
  const tokenCache = new Map<string, { token: string; cipher: string }>();
  async function tokenFor(store: string): Promise<{ token: string; cipher: string } | null> {
    if (tokenCache.has(store)) return tokenCache.get(store)!;
    const { data: conn } = await admin.from('tiktok_connections')
      .select('id, user_id, store_id, access_token, refresh_token, shop_cipher, token_expires_at').eq('store_id', store).maybeSingle();
    if (!conn?.access_token || !conn?.shop_cipher) return null;
    const fresh = await getFreshToken(admin, conn as unknown as ConnRow, { skewMinutes: 30 });
    const t = { token: fresh.accessToken as string, cipher: (fresh.shopCipher ?? conn.shop_cipher) as string };
    tokenCache.set(store, t); return t;
  }

  const globalIndex = new Map(included.map((b, i) => [b.key, i + 1]));

  // 5) getOrderById across the chunk's orders (batched) → package_id + fresh tracking per order.
  const pkgOf = new Map<string, string | null>(); const freshTrk = new Map<string, string | null>();
  const byStoreOrders = new Map<string, string[]>();
  for (const b of queue) { const s = b.storeId ?? ''; for (const o of b.orderIds) (byStoreOrders.get(s) ?? byStoreOrders.set(s, []).get(s)!).push(o); }
  for (const [store, oids] of byStoreOrders) {
    const tk = await tokenFor(store); if (!tk) continue;
    for (let i = 0; i < oids.length; i += 50) {
      try {
        const got = await getOrderById(tk.token, tk.cipher, oids.slice(i, i + 50));
        for (const o of got) { const id = String(o.id); const pk = (o.packages as { id?: string }[] | undefined)?.[0]?.id ?? null; pkgOf.set(id, pk); freshTrk.set(id, o.tracking_number ? String(o.tracking_number) : null); }
      } catch { /* leave unmapped → box goes UNVERIFIABLE / error */ }
    }
  }

  // 6) Compose each box: reconcile, fetch label, emit label+slip pair (or error sheet).
  const doc = await PDFDocument.create();
  const f = await embedFonts(doc);
  const failures: { order_id: string; tracking: string | null; reason: string; terminal: boolean }[] = [];
  let processed = 0; let budgetExhausted = false; let lastRep = after;

  for (const b of queue) {
    if (Date.now() - started >= TIME_BUDGET_MS) { budgetExhausted = true; break; }
    // Reconcile the DB box against the fetched package_id.
    const pkgIds = [...new Set(b.orderIds.map((o) => pkgOf.get(o)).filter((p): p is string => !!p))];
    const packageId = pkgIds[0] ?? null;
    const fresh = b.orderIds.map((o) => freshTrk.get(o)).find((t) => t) ?? b.tracking;
    const unverifiable = !b.hasTracking || pkgIds.length !== 1 || packageId == null;

    const slip: SlipModel = {
      orderId: b.rep, tracking: fresh ?? null, boxIndex: globalIndex.get(b.key) ?? processed + 1, boxTotal: totalIncluded,
      orderCount: b.counts.orderCount, packageLabel: null,
      itemCount: unverifiable ? null : b.counts.itemCount, unverifiable,
      setAside: b.counts.unresolvedCount > 0, unresolvedCount: b.counts.unresolvedCount, catalogCount: b.counts.catalogCount,
    };

    // Fetch the label (unless we have no package_id → straight to error sheet).
    let labelBytes: Uint8Array | null = null; let failReason = ''; let terminal = false;
    if (!packageId) { failReason = 'no package_id from order detail (no label / not returned)'; }
    else {
      const tk = await tokenFor(b.storeId ?? '');
      if (!tk) { failReason = 'no TikTok connection for store'; }
      else {
        for (let attempt = 0; attempt <= DOC_RETRY; attempt++) {
          let sd; try { sd = await getShippingDocument(tk.token, tk.cipher, packageId); }
          catch (e) { failReason = `shipping_documents error: ${String(e)}`; break; }
          if (sd.code === 0 && sd.docUrl) { try { labelBytes = new Uint8Array(await (await fetch(sd.docUrl)).arrayBuffer()); } catch { failReason = 'label doc_url fetch failed'; } break; }
          if (String(sd.code) === '11034037') { if (attempt < DOC_RETRY) { await sleep(1200); continue; } failReason = 'label still being generated — retry same-day'; break; }
          if (String(sd.code) === '21042102') { failReason = 'already picked up — no reprint (ship on current process)'; terminal = true; break; }
          failReason = sd.message || `shipping_documents code ${sd.code}`; break;
        }
      }
    }

    // Emit the pair in PAIR_ORDER. Failed label → an explicit error sheet in the label slot.
    for (const which of PAIR_ORDER) {
      if (which === 'label') {
        if (labelBytes) await addLabelPage(doc, labelBytes);
        else addErrorSheet(doc, f, { orderId: b.rep, tracking: fresh ?? null, boxIndex: globalIndex.get(b.key) ?? processed + 1, boxTotal: totalIncluded, reason: failReason || 'label unavailable', terminal });
      } else {
        addSlipPage(doc, f, slip);
      }
    }
    if (!labelBytes) failures.push({ order_id: b.rep, tracking: fresh ?? null, reason: failReason || 'label unavailable', terminal });
    processed++; lastRep = b.rep;
    await sleep(60);
  }

  const remaining = totalIncluded - included.filter((b) => b.rep <= lastRep).length;
  const pdfB64 = Buffer.from(await doc.save()).toString('base64');
  return NextResponse.json({
    pdf_base64: pdfB64,
    processed, remaining, next_after: remaining > 0 ? lastRep : null,
    included_boxes: totalIncluded, excluded_catalog_boxes: excludedCatalog,
    days: allDays ? 'all' : days,
    failures, failure_count: failures.length,
    label_fit_scale: A6_FIT.scale, pair_order: PAIR_ORDER,
    page_size: `${PAGE.w}x${PAGE.h}`,
    budget: { box_budget: boxBudget, ms_used: Date.now() - started, exhausted: budgetExhausted },
    note: remaining > 0 ? 'Re-invoke with next_after until remaining=0; collect PDFs in order.' : 'Batch complete.',
  });
}
