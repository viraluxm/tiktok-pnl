import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrgId } from '@/lib/org';
import { resolveAndUpsertBox } from '@/lib/fulfillment/box';

export const dynamic = 'force-dynamic';
const BUCKET = 'inventory-thumbnails';

// POST { scanned, workerId?, shiftId? } — picker scans TikTok's packing-slip barcode (= order_id).
//
// The device is logged in as the shared fulfillment account (an org member) which does NOT own
// synced_order_ids / live_auction_items (those are per-owner). So we resolve SERVER-SIDE with the
// admin client: scanned value → owning user_id (same-org only) → resolveAndUpsertBox under that
// owner (status 'picking'). A shared shop can be synced under >1 in-org account, so we prefer the
// owner that actually holds the live binding. Inventory is org-shared (035b), resolved by org.
//
// RESILIENT: if the scanned value is not a known order_id, we do NOT silently fail — we echo the
// raw value back so the first real scan reveals exactly what TikTok's barcode emits.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const callerOrg = await getOrgId(supabase, user.id);
  if (!callerOrg) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { scanned?: string; workerId?: string; shiftId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }
  const scanned = typeof body.scanned === 'string' ? body.scanned.trim() : '';
  if (!scanned) return NextResponse.json({ error: 'Empty scan' }, { status: 400 });

  // Shape guard: TikTok order ids are 18-digit numerics. Accept 16–20 digits for headroom.
  // A truncated/garbled read (e.g. a jittery scanner delivering only the last 7 digits) fails
  // this and is surfaced as "scan again" — NOT "unrecognized" — with the raw value echoed for
  // diagnosis. This runs BEFORE the owner-lookup so a bad read never masquerades as unknown.
  if (!/^\d{16,20}$/.test(scanned)) {
    return NextResponse.json({
      recognized: false,
      partial: true,
      scanned,
      message: `Partial/invalid scan (${scanned.length} chars) — scan again. Read: ${scanned}`,
    });
  }

  const admin = createAdminClient();

  // Owner-lookup (service-role bypasses per-user RLS). order_id is NOT globally unique — a shared
  // shop can be synced under multiple accounts — so collect all owners.
  const { data: syncedRows } = await admin
    .from('synced_order_ids').select('user_id').eq('order_id', scanned);
  const owners = [...new Set((syncedRows ?? []).map((r) => String(r.user_id)))];

  if (owners.length === 0) {
    // RESILIENT self-test: unknown code → tell the picker exactly what scanned so we learn whether
    // TikTok's barcode encodes the order_id or something else (tracking/package id).
    return NextResponse.json({ recognized: false, scanned, message: `Unrecognized code — this is what scanned: ${scanned}` });
  }

  // SECURITY: restrict to owners in THIS device's org — never resolve another org's orders.
  const { data: orgMembers } = await admin
    .from('organization_members').select('user_id').eq('org_id', callerOrg).in('user_id', owners);
  const inOrgOwners = owners.filter((o) => new Set((orgMembers ?? []).map((m) => String(m.user_id))).has(o));
  if (inOrgOwners.length === 0) {
    return NextResponse.json({ recognized: true, error: 'OUT_OF_ORG', message: 'That order belongs to a different organization.' }, { status: 403 });
  }

  // Prefer the owner that holds the live binding (the sale/capture). Falls back to the first
  // in-org owner (an unbound win → box resolves with no lines, surfaced to the picker).
  let ownerId = inOrgOwners[0];
  const { data: bound } = await admin
    .from('live_auction_items').select('user_id').eq('client_idempotency_key', scanned).in('user_id', inOrgOwners).limit(1);
  if (bound && bound.length) ownerId = String(bound[0].user_id);

  // Resolve/create the box under the OWNER, status 'picking'.
  const outcome = await resolveAndUpsertBox(admin, ownerId, callerOrg, scanned, 'picking');
  if (!outcome.ok) return NextResponse.json({ recognized: true, error: outcome.error }, { status: outcome.status });

  // A box pre-created 'unpicked' (e.g. a prior buy-labels run) → bump to 'picking' on first scan.
  if (outcome.box.status === 'unpicked') {
    await admin.from('fulfillment_orders').update({ status: 'picking' }).eq('id', outcome.box.fulfillment_order_id);
    outcome.box.status = 'picking';
  }

  // Enrich lines with thumbnails (box.ts stays unchanged; enrich here like the old station did).
  const skuIds = outcome.box.lines.map((l) => l.inventory_sku_id);
  const thumbBySku = new Map<string, string | null>();
  if (skuIds.length) {
    const { data: inv } = await admin
      .from('inventory_skus').select('id, thumbnail_path').eq('org_id', callerOrg).in('id', skuIds);
    for (const s of inv ?? []) {
      const path = (s.thumbnail_path as string | null) ?? null;
      thumbBySku.set(String(s.id), path ? admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null);
    }
  }
  const lines = outcome.box.lines.map((l) => ({ ...l, thumbnail_url: thumbBySku.get(l.inventory_sku_id) ?? null }));

  return NextResponse.json({ recognized: true, ...outcome.box, lines, scanned_order_id: scanned });
}
