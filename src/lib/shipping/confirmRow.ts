/**
 * Pure helpers for the shipping-confirm write. Self-contained (no '@/…' / npm value imports)
 * so the transpile-at-runtime .test.mjs pattern can exercise them.
 *
 * IMMUTABILITY CONTRACT: a shipment_verification's original KPI fields (verified_at,
 * pick_started_at, picker_employee_id, picker_name_snapshot) are established by the FIRST
 * successful confirmation and must never be rewritten. The confirm route enforces this at the
 * database level with INSERT … ON CONFLICT (user_id, group_key) DO NOTHING (supabase-js
 * `upsert(..., { ignoreDuplicates: true })`) — atomic, no read-then-write race, and the
 * existing unique (user_id, group_key) still guarantees one completed-box row per account.
 * `simulateInsertIgnoreDuplicates` below models exactly that policy for unit tests.
 */

export interface VerificationRowInput {
  userId: string;
  groupKey: string;
  orderIds: string[];
  verifiedAt: string;                    // ISO completion time (now, at confirm)
  storeId?: string | null;
  pickerEmployeeId?: string | null;      // already validated; null when not attributed
  pickerNameSnapshot?: string | null;    // picker's current name at pick time
  pickStartedAt?: string | null;         // normalized ISO box-load time, or null
}

/**
 * Build the row the confirm route inserts. Optional KPI fields are included ONLY when present,
 * so the FIRST insert records exactly what the client supplied (a missing picker → Unassigned;
 * a missing start → no duration). Under ON CONFLICT DO NOTHING these fields are only ever
 * written by the first confirm, so a later re-confirm can neither overwrite nor backfill them.
 */
export function buildVerificationRow(input: VerificationRowInput): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: input.userId,
    group_key: input.groupKey,
    order_ids: input.orderIds,
    verified_at: input.verifiedAt,
  };
  if (input.storeId) row.store_id = input.storeId;
  if (input.pickerEmployeeId) {
    row.picker_employee_id = input.pickerEmployeeId;
    row.picker_name_snapshot = input.pickerNameSnapshot ?? null;
  }
  if (input.pickStartedAt) row.pick_started_at = input.pickStartedAt;
  return row;
}

/**
 * Model of Postgres `INSERT … ON CONFLICT (user_id, group_key) DO NOTHING` — the exact policy
 * the confirm route pins via `ignoreDuplicates: true`. First write for a (user_id, group_key)
 * wins and is stored verbatim; any later write for the same key is a successful NO-OP that
 * changes nothing. `store` is keyed by `${user_id}::${group_key}` (mirrors the unique index).
 * Returns whether this call inserted a new row.
 */
export function simulateInsertIgnoreDuplicates(
  store: Map<string, Record<string, unknown>>,
  row: Record<string, unknown>,
): { inserted: boolean } {
  const key = `${String(row.user_id)}::${String(row.group_key)}`;
  if (store.has(key)) return { inserted: false }; // DO NOTHING — original row preserved
  store.set(key, { ...row });
  return { inserted: true };
}
