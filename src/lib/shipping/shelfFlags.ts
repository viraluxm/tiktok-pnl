import type { SupabaseClient } from '@supabase/supabase-js';
import { validatePicker } from '@/lib/shipping/pickerPerformance';

// Picker-reported "can't find it on the shelf" flags (table: sku_shelf_flags, migration 102).
//
// THE READ WINDOW LIVES HERE AND NOWHERE ELSE. A flag is a picker's observation of a physical
// shelf at one instant; it decays. Rather than expiring rows (a write path, and a lie about
// history), reads treat a flag as live only while reported_at is inside the window. Both pick
// readers — /api/shipping/pick-list and lib/shipping/scanResolve's assembleBox — go through
// fetchLiveShelfFlags, so the window can never drift between the two surfaces.
//
// Clearing is application-side only (confirm-path 'grabbed', explicit 'undo'). There is no
// restock trigger by design: the capture path stays untouched.

// Hours a report stays live. Override with SHELF_FLAG_WINDOW_HOURS (server env). A non-numeric
// or non-positive value falls back to the default rather than disabling flags outright.
const DEFAULT_WINDOW_HOURS = 24;
const parsed = Number(process.env.SHELF_FLAG_WINDOW_HOURS);
export const SHELF_FLAG_WINDOW_HOURS =
  Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_HOURS;

// The oldest reported_at that still counts as live, as an ISO string for PostgREST.
export function shelfFlagCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - SHELF_FLAG_WINDOW_HOURS * 3600 * 1000).toISOString();
}

// The set of inventory_sku_ids currently flagged out-of-stock for these owners.
//
// Best-effort by design: a failed/erroring read returns an EMPTY set, so a flag lookup problem
// degrades to "no band shown" and never blocks a pick. `userIds` scopes to the box owner(s) —
// the station passes owner ids, the operator flow passes its own.
export async function fetchLiveShelfFlags(
  db: SupabaseClient,
  userIds: string[],
  skuIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (!userIds.length || !skuIds.length) return new Set();
  const { data, error } = await db
    .from('sku_shelf_flags')
    .select('inventory_sku_id')
    .in('user_id', userIds)
    .in('inventory_sku_id', skuIds)
    .is('cleared_at', null)
    .gte('reported_at', shelfFlagCutoffIso(now));
  if (error) {
    console.warn('[shelfFlags] read failed, treating all SKUs as unflagged:', error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => String(r.inventory_sku_id)));
}

// Resolve the reporting PICKER for attribution, scoped to the box owner's employees.
//
// Same contract as the confirm routes' attribution: best-effort, never a hard failure. An
// absent / foreign / non-fulfillment / former picker yields nulls and the flag still records
// unattributed — a picker whose employee row is misconfigured must still be able to tell the
// next picker the shelf is empty. (Lives here rather than in pickerPerformance.ts, which is
// deliberately pure and dependency-free.)
export async function resolveFlagPicker(
  db: SupabaseClient,
  ownerUserId: string,
  rawPickerId: string,
  tag: string,
): Promise<{ employeeId: string | null; employeeName: string | null }> {
  if (!rawPickerId) return { employeeId: null, employeeName: null };
  const { data: emp } = await db
    .from('employees')
    .select('id, name, role, status')
    .eq('user_id', ownerUserId)
    .eq('id', rawPickerId)
    .maybeSingle();
  const v = validatePicker(emp);
  if (v.valid && emp) return { employeeId: emp.id as string, employeeName: emp.name as string };
  console.warn(`[${tag}] shelf flag not attributed (${v.reason})`);
  return { employeeId: null, employeeName: null };
}

// Report a SKU as not-on-the-shelf. Upsert on (user_id, inventory_sku_id): re-reporting a SKU
// whose flag was cleared revives the SAME row with a fresh reported_at and cleared_* nulled,
// so the window restarts and no duplicate accumulates.
export async function reportShelfOut(
  db: SupabaseClient,
  args: { ownerUserId: string; skuId: string; employeeId: string | null; employeeName: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db.from('sku_shelf_flags').upsert(
    {
      user_id: args.ownerUserId,
      inventory_sku_id: args.skuId,
      reported_at: new Date().toISOString(),
      reported_by_employee_id: args.employeeId,
      reported_by_name: args.employeeName,
      cleared_at: null,
      cleared_by_employee_id: null,
      cleared_reason: null,
    },
    { onConflict: 'user_id,inventory_sku_id' },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

// Clear flags for one or more SKUs.
//   'grabbed' — PRIMARY path, written by the confirm route for every SKU actually picked in the
//               box. A unit reaching a picker's hand outranks any report that it was missing.
//   'undo'    — secondary, the picker toggling the band off from the card.
// Narrowed to rows that are still live (cleared_at is null) so a re-confirm never rewrites an
// earlier clear's reason or timestamp.
export async function clearShelfFlags(
  db: SupabaseClient,
  args: {
    ownerUserId: string;
    skuIds: string[];
    employeeId: string | null;
    reason: 'grabbed' | 'undo';
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!args.skuIds.length) return { ok: true };
  const { error } = await db
    .from('sku_shelf_flags')
    .update({
      cleared_at: new Date().toISOString(),
      cleared_by_employee_id: args.employeeId,
      cleared_reason: args.reason,
    })
    .eq('user_id', args.ownerUserId)
    .in('inventory_sku_id', args.skuIds)
    .is('cleared_at', null);
  return error ? { ok: false, error: error.message } : { ok: true };
}
