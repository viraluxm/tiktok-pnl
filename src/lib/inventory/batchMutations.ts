// Pure, framework-independent helpers for FIFO cost-layer (sku_batches) mutations:
// EDIT (remaining qty and/or unit cost), DELETE, and the create-SKU SEED layer.
// Deliberately NO React / Supabase / DOM imports so this unit-tests directly under
// plain `node` (see batchMutations.test.mjs), matching filterSkus.ts.
//
// The database RPCs lensed_edit_batch / lensed_delete_batch are the SOURCE OF TRUTH
// for every rule (org scoping, the SKU advisory lock, the qty_on_hand lockstep, the
// untouched-delete guard, never touching sale snapshots). These helpers only mirror
// the INPUT validation and translate RPC error tokens into HTTP responses so the API
// routes stay thin — the server enforces the rules regardless of what the client sends.

// Strict integer coercion: accepts a number or a numeric string, rejects NaN /
// Infinity / fractionals / blanks. We reject a fractional quantity rather than
// silently truncating one — an inventory correction should be exact.
function toIntStrict(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

export interface BatchEditInput {
  qty_remaining: unknown;
  unit_cost_cents: unknown;
}

export interface BatchEditValues {
  qty_remaining: number;
  unit_cost_cents: number | null;
  // Whether the caller actually supplied a cost. When false the RPC (p_set_cost)
  // leaves the existing cost untouched — an OMITTED field can never clear a cost.
  set_cost: boolean;
}

export type BatchEditParse =
  | { ok: true; value: BatchEditValues }
  | { ok: false; error: string };

// Validate/normalize an edit payload before it reaches lensed_edit_batch.
//   • qty_remaining: an integer >= 0 (a CURRENT-remaining correction; the batch's
//     original quantity is never edited by hand).
//   • unit_cost_cents: only considered when `costProvided` is true (i.e. the request
//     actually included the field). Then null/blank ⇒ null (explicit "unknown"), a
//     nonnegative integer ⇒ that value — matching the lensed_add_batch convention.
//     When `costProvided` is false the cost is left entirely alone (set_cost=false),
//     so an omitted field cannot accidentally blank an existing cost.
// Mirrors the server-side checks in lensed_edit_batch so bad input fails fast as 400.
export function parseBatchEdit(input: BatchEditInput, costProvided: boolean): BatchEditParse {
  const qty = toIntStrict(input.qty_remaining);
  if (qty === null || qty < 0) {
    return { ok: false, error: 'Remaining quantity must be a whole number of at least 0' };
  }

  if (!costProvided) {
    // Qty-only edit: do not read or validate cost; the RPC keeps the existing value.
    return { ok: true, value: { qty_remaining: qty, unit_cost_cents: null, set_cost: false } };
  }

  const rawCost = input.unit_cost_cents;
  let cost: number | null;
  if (rawCost === null || rawCost === undefined || rawCost === '') {
    cost = null; // explicit unknown cost — a valid, intentional value
  } else {
    const c = toIntStrict(rawCost);
    if (c === null || c < 0) {
      return { ok: false, error: 'Unit cost must be empty or an amount of at least 0' };
    }
    cost = c;
  }

  return { ok: true, value: { qty_remaining: qty, unit_cost_cents: cost, set_cost: true } };
}

export interface SeedBatchArgs {
  userId: string;
  skuId: string;
  qtyOnHand: number | null;
  unitCostCents: number | null;
}

// The seq-1 cost layer inserted when a SKU is created. Populates qty_added (= the
// starting qty) so a still-untouched seed layer is later deletable — consistent with
// lensed_add_batch and the ViewTrack admin path. org_id is stamped by the
// zz_set_org_id trigger; a brand-new SKU has no prior layers, so sequence is always 1.
export function buildSeedBatchRow(args: SeedBatchArgs): {
  user_id: string;
  sku_id: string;
  qty_remaining: number;
  qty_added: number;
  unit_cost_cents: number | null;
  sequence: number;
} {
  const qty = args.qtyOnHand ?? 0;
  return {
    user_id: args.userId,
    sku_id: args.skuId,
    qty_remaining: qty,
    qty_added: qty,
    unit_cost_cents: args.unitCostCents ?? null,
    sequence: 1,
  };
}

export interface BatchRpcErrorResponse {
  status: number;
  error: string;
}

// Translate an error raised by lensed_edit_batch / lensed_delete_batch into an HTTP
// status + user-facing message. Legacy-NULL and partly-consumed layers both raise
// BATCH_NOT_DELETABLE and share one message (per the approved spec). Unknown errors
// fall through to 500 so the route logs and returns a generic failure.
export function mapBatchRpcError(message: string | null | undefined): BatchRpcErrorResponse {
  const m = message ?? '';
  if (m.includes('BATCH_NOT_FOUND')) return { status: 404, error: 'Batch not found' };
  if (m.includes('INVALID_QTY')) return { status: 400, error: 'Remaining quantity must be a whole number of at least 0' };
  if (m.includes('INVALID_COST')) return { status: 400, error: 'Unit cost must be empty or an amount of at least 0' };
  if (m.includes('BATCH_NOT_DELETABLE')) {
    return {
      status: 409,
      error:
        'This layer has unverified or existing sales history and cannot be deleted. Edit its remaining quantity to 0 instead.',
    };
  }
  if (m.includes('CANNOT_DELETE_LAST_BATCH')) {
    return {
      status: 409,
      error:
        "This is the SKU's only cost layer and can't be deleted. Add another layer first, or edit its remaining quantity instead.",
    };
  }
  if (m.includes('NO_ORG')) return { status: 403, error: 'No organization is linked to this account' };
  if (m.includes('NOT_AUTHENTICATED')) return { status: 401, error: 'Unauthorized' };
  return { status: 500, error: 'Failed to update batch' };
}
