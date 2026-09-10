import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validatePicker } from '@/lib/shipping/pickerPerformance';
import { isBatchCode } from '@/lib/shipping/code128';
import { resolveBatchByCode } from '@/lib/shipping/singlesBatches';
import { refundBlockedOrders } from '@/lib/shipping/scanResolve';

// Credit a finished SINGLES pile. Shared by the owner-session route (/api/shipping/singles-scan)
// and the station route (/api/station/singles-scan) so the two surfaces can never drift on who
// gets credited, what is excluded, or what the packer is told.
//
// `ownerId` is the account that OWNS the boxes — never the station account. The verification
// row's user_id keys the UNIQUE (user_id, group_key) dedup, so a row written under the wrong id
// would never collapse against the operator flow and the same box could be credited twice.

export type CreditFailure =
  | { ok: false; status: number; error: string; reason?: string };

export interface CreditSuccess {
  ok: true;
  batch: { code: string; caption: string };
  picker: string;
  printed: number;
  credited: number;
  already_counted: number;
  blocked: number;
}

interface Label { group_key: string; order_ids: string[] | null }

export async function creditSinglesBatch(
  admin: SupabaseClient,
  ownerId: string,
  rawCode: string,
  rawPickerId: string,
): Promise<CreditSuccess | CreditFailure> {
  const code = rawCode.trim().toUpperCase();
  if (!isBatchCode(code)) {
    return { ok: false, status: 400, error: 'That is not a singles batch barcode.' };
  }

  // ── The picker is REQUIRED here, unlike a pack confirm. ──
  // A confirm records the box even unattributed, because recording the box is what matters. This
  // path exists ONLY to attribute work, so writing unattributed rows would recreate the very bug
  // it was built to fix — silently, and unrepeatably, because dedup makes the corrective re-scan
  // a no-op and the credit is then lost for good.
  const pickerId = rawPickerId.trim();
  if (!pickerId) {
    return { ok: false, status: 400, error: 'Choose who is packing before scanning.' };
  }
  const { data: emp } = await admin
    .from('employees')
    .select('id, name, role, status')
    .eq('user_id', ownerId)
    .eq('id', pickerId)
    .maybeSingle();
  const v = validatePicker(emp);
  if (!v.valid || !emp) {
    return { ok: false, status: 400, error: 'That person cannot be credited for picking.', reason: v.reason };
  }

  const batch = await resolveBatchByCode(ownerId, code);
  if (!batch) return { ok: false, status: 404, error: 'Unknown batch barcode.' };
  if (batch.group_keys.length === 0) {
    return { ok: false, status: 409, error: 'That batch has no labels.' };
  }

  // The pile's boxes live ON the batch — the slip fronts exactly these labels, whichever runs they
  // were bought in. Labels are printed combined across shops, so a pile routinely spans a dozen
  // runs and there is no single run to look them up by.
  const { data: labelRows, error: labelErr } = await admin
    .from('shipping_label_purchases')
    .select('group_key, order_ids')
    .eq('user_id', ownerId)
    .in('group_key', batch.group_keys);
  if (labelErr) {
    console.error('[singles-credit] label read failed:', labelErr);
    return { ok: false, status: 500, error: 'Could not read that batch.' };
  }
  const ordersByGroup = new Map<string, string[]>();
  for (const r of (labelRows ?? []) as Label[]) ordersByGroup.set(String(r.group_key), r.order_ids ?? []);
  const labels: Label[] = batch.group_keys.map((k) => ({ group_key: k, order_ids: ordersByGroup.get(k) ?? [] }));

  // ── Refund guard. ──
  // A refunded or cancelled order must never be packed — TikTok has already paid the buyer back.
  // Crediting one would count work that should not have happened and imply the parcel went out.
  const allOrderIds = [...new Set(labels.flatMap((l) => l.order_ids ?? []))];
  const blocked = await refundBlockedOrders(admin, [ownerId], allOrderIds);
  const packable = labels.filter((l) => !(l.order_ids ?? []).some((id) => blocked.has(id)));
  const blockedCount = labels.length - packable.length;

  // ── What is already counted. ──
  // Read first so the packer can be told the truth. The slip says "148 LABELS"; if 18 were already
  // confirmed at the pack station the honest answer is "credited 130 of 148", not a number that
  // silently disagrees with the paper in their hand.
  const packableKeys = packable.map((l) => l.group_key);
  const { data: existing, error: exErr } = await admin
    .from('shipment_verifications')
    .select('group_key')
    .eq('user_id', ownerId)
    .in('group_key', packableKeys);
  if (exErr) {
    console.error('[singles-credit] existing read failed:', exErr);
    return { ok: false, status: 500, error: 'Could not read that batch.' };
  }
  const already = new Set((existing ?? []).map((r) => String(r.group_key)));
  const toWrite = packable.filter((l) => !already.has(l.group_key));

  if (toWrite.length > 0) {
    const now = new Date().toISOString();
    const rows = toWrite.map((l) => ({
      user_id: ownerId,
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
    // it, a duplicate scan is a successful no-op, and two people scanning one pile at once race
    // safely.
    const { error: insErr } = await admin
      .from('shipment_verifications')
      .upsert(rows, { onConflict: 'user_id,group_key', ignoreDuplicates: true });
    if (insErr) {
      console.error('[singles-credit] credit write failed:', insErr);
      return { ok: false, status: 500, error: 'Could not credit that batch.' };
    }
  }

  return {
    ok: true,
    batch: { code: batch.code, caption: batch.slip_caption },
    picker: emp.name as string,
    printed: labels.length,
    credited: toWrite.length,
    already_counted: already.size,
    blocked: blockedCount,
  };
}
