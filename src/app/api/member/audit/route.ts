import { NextResponse } from 'next/server';
import { requireMemberScope } from '@/lib/station/guard';
import type { AuditLine, AuditRow } from '@/lib/member/multibind';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

// GET /api/member/audit — the squish over-bind queue: sold orders whose bound SKUs are ALL squish
// and total more than one unit. A squish is never bundled, so every one of these is a host who
// scanned twice (one line, qty 2) or scanned the next item onto the previous sale (two lines).
//
// The whole predicate lives in squish_multibind_audit_as (migrations 134 + 135) — a GROUP BY / HAVING
// across live_auction_items → live_auction_item_skus → inventory_skus that PostgREST cannot
// express, and that would silently truncate at 1,000 rows if read table-by-table.
// rpc-grants: squish_multibind_audit_as
//
// OFFSET pagination, not keyset: the RPC returns total_count so the UI can show real page numbers,
// and the window (14 days by default) keeps the set small enough that offset costs nothing.
//
// Owner-scoped (service_role), gated on requireMemberScope('binding') — the same team that works
// the binding queue works this one, so no new member scope has to be provisioned.
export async function GET(req: Request) {
  const scope = await requireMemberScope('binding');
  if (!scope.ok) return scope.response;
  const { admin, ownerIds, storeIds, allStores } = scope;

  const url = new URL(req.url);
  const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(url.searchParams.get('days') ?? '', 10) || DEFAULT_DAYS));
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '', 10) || 50));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '', 10) || 0);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // ?store_id — narrow to ONE shop, because that is how the team verifies: they work a shop at a
  // time against what that shop actually sold. Absent = every shop in scope.
  //
  // VALIDATED AGAINST THE MEMBER'S OWN storeIds, so this can only ever NARROW their scope, never
  // widen it: a store-restricted member asking for someone else's shop gets a 403, not that shop's
  // rows. Same contract as /api/member/unbound's store_id.
  //
  // No 'unmapped' sentinel here (unlike the unbound queue, where null-store rows are common and
  // need their own pill). The RPC resolves a flagged order's shop as
  // coalesce(synced_order_ids.store_id, live_auction_items.store_id), and across the live 14-day
  // queue that resolves for EVERY row — the per-shop counts sum to the exact total. Should a
  // null-store row ever appear it is still reachable under "All shops".
  const rawStore = url.searchParams.get('store_id')?.trim() || null;
  if (rawStore && !storeIds.includes(rawStore)) {
    return NextResponse.json({ error: 'store_id not in scope' }, { status: 403 });
  }

  // ?unpacked=0 to see everything; DEFAULT IS ON (unpacked only), because a correction on a box
  // that has already been packed is WRONG: both units physically left, so restocking one claims a
  // unit that is with a customer. The queue's default must be the rows where the fix is right.
  // 'unpacked' is defined in migration 135 as: no shipment_verifications row AND the platform still
  // says AWAITING_SHIPMENT/AWAITING_COLLECTION (neither signal is sufficient alone — see that file).
  const unpackedOnly = (url.searchParams.get('unpacked') ?? '1') !== '0';

  const { data, error } = await admin.rpc('squish_multibind_audit_as', {
    p_owner_user_ids: ownerIds,
    // One shop selected → hand the RPC exactly that shop and turn the all-stores bypass OFF, so its
    // store predicate actually applies. Otherwise pass the member's full assignment unchanged.
    p_store_ids: rawStore ? [rawStore] : storeIds,
    p_all_stores: rawStore ? false : allStores,
    p_since: since,
    p_limit: limit,
    p_offset: offset,
    p_unpacked_only: unpackedOnly,
  });
  if (error) {
    console.error('[member/audit] rpc error:', error.code, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const raw = (data ?? []) as Record<string, unknown>[];
  // total_count rides on every row (count(*) over ()); an empty page means an empty set.
  const total = raw.length ? Number(raw[0].total_count) || 0 : 0;

  const rows: AuditRow[] = raw.map((r) => {
    const lines = (Array.isArray(r.lines) ? r.lines : []) as Record<string, unknown>[];
    return {
      order_id: String(r.order_id),
      item_id: String(r.item_id),
      session_id: r.session_id ? String(r.session_id) : null,
      store_id: r.store_id ? String(r.store_id) : null,
      bound_at: String(r.bound_at ?? ''),
      ordered_at: (r.ordered_at as string | null) ?? null,
      units: Number(r.units) || 0,
      line_count: Number(r.line_count) || 0,
      tiktok_title: (r.tiktok_title as string | null) ?? null,
      buyer_handle: (r.buyer_handle as string | null) ?? null,
      won_price_cents: (r.won_price_cents as number | null) ?? null,
      lot_hint: (r.lot_hint as string | null) ?? null,
      tiktok_status: (r.tiktok_status as string | null) ?? null,
      tracking_number: (r.tracking_number as string | null) ?? null,
      pack_verified: r.pack_verified === true,
      unpacked: r.unpacked === true,
      lines: lines.map((l): AuditLine => {
        const path = (l.thumbnail_path as string | null) ?? null;
        return {
          sku_id: String(l.sku_id),
          sku_number: (l.sku_number as number | null) ?? null,
          title: (l.title as string | null) ?? null,
          qty: Number(l.qty) || 1,
          unit_cost_cents: (l.unit_cost_cents as number | null) ?? null,
          category: (l.category as string | null) ?? null,
          thumbnail_url: path ? admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
        };
      }),
    };
  });

  return NextResponse.json({ rows, total, days, limit, offset, store_id: rawStore, unpacked_only: unpackedOnly });
}
