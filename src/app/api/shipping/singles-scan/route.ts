import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validatePicker } from '@/lib/shipping/pickerPerformance';
import { isBatchCode } from '@/lib/shipping/code128';
import { resolveBatchByCode } from '@/lib/shipping/singlesBatches';
import { refundBlockedOrders } from '@/lib/shipping/scanResolve';

export const dynamic = 'force-dynamic';

// POST /api/shipping/singles-scan  { code, picker_employee_id }
//
// Credit a finished SINGLES pile. The packer scans the header slip's barcode as they FINISH the
// pile and every label in it is credited to them, as ordinary boxes.
//
// WHY THIS EXISTS: singles were credited to nobody. Runs of 521 / 323 / 304 labels printed under
// 'SINGLES — PREP STATION' had ZERO rows in shipment_verifications — roughly a third of all
// packages created, missing from every picker KPI and from the $/box and $/SKU cost math.
//
// WHY IT MINTS ORDINARY BOX ROWS rather than a parallel counter: the boxes already exist, with
// real trackings. Writing the same rows the pack station writes means the DB's
// UNIQUE (user_id, group_key) does the deduplication for free — a re-scan is a no-op, and if
// someone later scans an individual label from the pile it collapses to the same row instead of
// double-crediting. A separate table would have had neither guarantee.
//
// SCAN ON FINISH, NOT ON START. A scan at the start would credit work that has not happened yet
// and anyone pulled away mid-pile would keep the full count.

interface Label { group_key: string; order_ids: string[] | null }

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { code?: string; picker_employee_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const code = String(body.code ?? '').trim().toUpperCase();
  if (!isBatchCode(code)) {
    return NextResponse.json({ error: 'That is not a singles batch barcode.' }, { status: 400 });
  }

  // ── The picker is REQUIRED here, unlike a pack confirm. ──
  // A confirm records the box even unattributed, because the box being recorded is what matters.
  // This endpoint exists ONLY to attribute work, so writing rows with nobody attached would
  // recreate the exact problem it was built to fix — silently, and unrepeatably, since a second
  // scan would then be a no-op with the credit lost for good.
  const rawPicker = String(body.picker_employee_id ?? '').trim();
  if (!rawPicker) {
    return NextResponse.json({ error: 'Choose who is packing before scanning.' }, { status: 400 });
  }
  const { data: emp } = await supabase
    .from('employees')
    .select('id, name, role, status')
    .eq('user_id', user.id)
    .eq('id', rawPicker)
    .maybeSingle();
  const v = validatePicker(emp);
  if (!v.valid || !emp) {
    return NextResponse.json(
      { error: 'That person cannot be credited for picking.', reason: v.reason },
      { status: 400 },
    );
  }

  const batch = await resolveBatchByCode(user.id, code);
  if (!batch) return NextResponse.json({ error: 'Unknown batch barcode.' }, { status: 404 });

  const admin = createAdminClient();

  // The pile's labels. Never stored on the batch — always read back from the ledger, so a batch
  // can never disagree with what was actually printed.
  const { data: labelRows, error: labelErr } = await admin
    .from('shipping_label_purchases')
    .select('group_key, order_ids')
    .eq('user_id', user.id)                      // explicit owner scope; service-role bypasses RLS
    .eq('run_id', batch.run_id)
    .eq('slip_caption', batch.slip_caption);
  if (labelErr) {
    console.error('[singles-scan] label read failed:', labelErr);
    return NextResponse.json({ error: 'Could not read that batch.' }, { status: 500 });
  }
  const labels = (labelRows ?? []) as Label[];
  if (labels.length === 0) {
    return NextResponse.json({ error: 'That batch has no labels.' }, { status: 409 });
  }

  // ── Refund guard. ──
  // A refunded or cancelled order must never be packed — TikTok has already paid the buyer back.
  // Crediting one would count work that should not have happened and imply the parcel went out.
  const allOrderIds = [...new Set(labels.flatMap((l) => l.order_ids ?? []))];
  const blocked = await refundBlockedOrders(admin, [user.id], allOrderIds);
  const packable = labels.filter((l) => !(l.order_ids ?? []).some((id) => blocked.has(id)));
  const blockedCount = labels.length - packable.length;

  // ── What is already counted. ──
  // Read first so the response can tell the packer the truth. The slip says "148 LABELS"; if 18
  // were already confirmed at the pack station the honest answer is "credited 130 of 148", not a
  // number that silently disagrees with the paper in their hand.
  const groupKeys = packable.map((l) => l.group_key);
  const { data: existing, error: exErr } = await admin
    .from('shipment_verifications')
    .select('group_key')
    .eq('user_id', user.id)
    .in('group_key', groupKeys);
  if (exErr) {
    console.error('[singles-scan] existing read failed:', exErr);
    return NextResponse.json({ error: 'Could not read that batch.' }, { status: 500 });
  }
  const already = new Set((existing ?? []).map((r) => String(r.group_key)));
  const toWrite = packable.filter((l) => !already.has(l.group_key));

  if (toWrite.length > 0) {
    const now = new Date().toISOString();
    const rows = toWrite.map((l) => ({
      user_id: user.id,
      group_key: l.group_key,
      order_ids: l.order_ids ?? [],
      verified_at: now,
      picker_employee_id: emp.id as string,
      picker_name_snapshot: emp.name as string,
      // Tagged so singles are reported on their own line and NEVER inherit the picking work model
      // (~47.5s per box + ~17.3s per item), which was fitted on rack picking and would over-credit
      // batch assembly roughly 2-3x.
      source: 'singles_batch' as const,
      // pick_started_at stays NULL on purpose: nothing here observed a pick starting, and a
      // fabricated timestamp would feed the duration KPIs a number nobody measured.
    }));

    // Same ON CONFLICT DO NOTHING contract as a pack confirm: whoever recorded a box first keeps
    // it, and a duplicate scan is a successful no-op rather than an error the packer has to think
    // about. This also closes the race between two people scanning the same pile at once.
    const { error: insErr } = await admin
      .from('shipment_verifications')
      .upsert(rows, { onConflict: 'user_id,group_key', ignoreDuplicates: true });
    if (insErr) {
      console.error('[singles-scan] credit write failed:', insErr);
      return NextResponse.json({ error: 'Could not credit that batch.' }, { status: 500 });
    }
  }

  return NextResponse.json({
    batch: { code: batch.code, caption: batch.slip_caption },
    picker: emp.name as string,
    printed: labels.length,
    credited: toWrite.length,
    already_counted: already.size,
    blocked: blockedCount,
  });
}
