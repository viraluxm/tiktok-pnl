// THE ONE box resolver. pick-list, the compose route, and the sample generator ALL call this —
// there is no second implementation. A "box" is the physical PACKAGE. Resolution is TRACKING-FIRST
// (one label = one package, the authoritative key) UNION combine-group (fallback for rows whose
// tracking isn't populated yet). Store-scoped. Seeds from a scanned tracking OR order id.
//
// Extracted verbatim from pick-list (behavior-preserving). normalizeTracking keeps its post-#72
// fail-safe behavior UNCHANGED — broadening it fabricates false matches (#71).

import type { SupabaseClient } from '@supabase/supabase-js';

// USPS IMpb mod-10 check digit over the first 21 of a 22-digit tracking.
export function uspsTrackingValid(t: string): boolean {
  if (!/^\d{22}$/.test(t)) return false;
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += Number(t[i]) * (((20 - i) % 2 === 0) ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(t[21]);
}

// Normalize a scanned shipping-label / tracking string to the canonical 22-digit USPS IMpb.
// Returns null when the scan isn't a tracking → order_id path. (Verbatim from pick-list; do not
// broaden — #71 proved broadening creates false matches, worse than failing.)
export function normalizeTracking(digits: string): string | null {
  if (/^9[2-5]\d{20}$/.test(digits)) return digits;
  const regions = [digits];
  if (digits.startsWith('420')) { regions.push(digits.slice(8)); regions.push(digits.slice(12)); }
  for (const region of regions) {
    for (let i = 0; i + 22 <= region.length; i++) {
      if (!/^9[2-5]/.test(region.slice(i, i + 2))) continue;
      const win = region.slice(i, i + 22);
      if (uspsTrackingValid(win)) return win;
    }
    const start = region.search(/9[2-5]/);
    if (start >= 0 && region.length - start > 22 && region.length - start <= 26) {
      let s = region.slice(start);
      while (s.length > 22) {
        let best = -1, bestLen = 0; const re = /0+/g; let mm: RegExpExecArray | null;
        while ((mm = re.exec(s))) if (mm[0].length > bestLen) { bestLen = mm[0].length; best = mm.index; }
        if (best < 0) break;
        s = s.slice(0, best) + s.slice(best + 1);
      }
      if (s.length === 22 && /^9[2-5]/.test(s) && uspsTrackingValid(s)) return s;
    }
  }
  return null;
}

export interface BoxRow {
  order_id: string; auto_combine_group_id: string | null; tracking_number: string | null;
  store_id: string | null; status: string | null; sku_name: string | null;
  tiktok_product_id: string | null; units: number | null;
}
export const BOX_SEL = 'order_id, auto_combine_group_id, tracking_number, store_id, status, sku_name, tiktok_product_id, units';

export interface ResolvedBox {
  boxRows: Map<string, BoxRow>;     // every order in the physical box (DB resolution)
  orderIds: string[];
  scannedOrderId: string;
  resolvedVia: 'tracking' | 'order_id';
  parsedTracking: string | null;
  boxTrackings: string[];
  boxGroups: string[];
  storeId: string | null;
  groupId: string | null;
  groupKey: string;
  // reconciliation inputs — TRUE when the box has NO reliable physical key, so a count can't be trusted
  hasReliableKey: boolean;          // ≥1 order carries a tracking (the authoritative bridge)
}
export type ResolveResult =
  | { ok: true; box: ResolvedBox }
  | { ok: false; scannedValue: string; parsedTracking: string | null; resolvedVia: 'tracking' | 'order_id' };

// Resolve a scanned value (label tracking or order id) → the full physical box. Store-scoped.
export async function resolveBox(supabase: SupabaseClient, userId: string, raw: string): Promise<ResolveResult> {
  const digits = raw.replace(/\s/g, '');
  const tracking = normalizeTracking(digits);
  let resolvedVia: 'tracking' | 'order_id' = tracking ? 'tracking' : 'order_id';

  let seed: BoxRow[] = [];
  if (tracking) {
    const { data } = await supabase.from('synced_order_ids').select(BOX_SEL).eq('user_id', userId).eq('tracking_number', tracking);
    seed = (data ?? []) as BoxRow[];
  }
  if (!seed.length && /^\d{6,}$/.test(digits)) {
    const { data } = await supabase.from('synced_order_ids').select(BOX_SEL).eq('user_id', userId).eq('order_id', digits).maybeSingle();
    if (data) { seed = [data as BoxRow]; resolvedVia = 'order_id'; }
  }
  if (!seed.length) return { ok: false, scannedValue: raw, parsedTracking: tracking, resolvedVia };

  const boxTrackings = [...new Set(seed.map((s) => s.tracking_number).filter((t): t is string => !!t))];
  const boxGroups = [...new Set(seed.map((s) => s.auto_combine_group_id).filter((g): g is string => !!g))];
  const storeId: string | null = seed[0].store_id ?? null;

  const boxRows = new Map<string, BoxRow>();
  seed.forEach((s) => boxRows.set(String(s.order_id), s));
  if (boxTrackings.length) {
    let q = supabase.from('synced_order_ids').select(BOX_SEL).eq('user_id', userId).in('tracking_number', boxTrackings);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    (data ?? []).forEach((r) => boxRows.set(String((r as BoxRow).order_id), r as BoxRow));
  }
  if (boxGroups.length) {
    let q = supabase.from('synced_order_ids').select(BOX_SEL).eq('user_id', userId).in('auto_combine_group_id', boxGroups);
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    for (const r of (data ?? []) as BoxRow[]) {
      const t = r.tracking_number;
      if (!boxTrackings.length || t === null || boxTrackings.includes(t)) boxRows.set(String(r.order_id), r);
    }
  }

  const orderIds = [...boxRows.keys()];
  const scannedOrderId = String(seed[0].order_id);
  const groupId: string | null = boxGroups[0] ?? null;
  const groupKey = boxTrackings[0] ? `trk:${boxTrackings[0]}` : (groupId ?? `order:${scannedOrderId}`);

  return {
    ok: true,
    box: {
      boxRows, orderIds, scannedOrderId, resolvedVia, parsedTracking: tracking,
      boxTrackings, boxGroups, storeId, groupId, groupKey,
      hasReliableKey: boxTrackings.length > 0,
    },
  };
}
