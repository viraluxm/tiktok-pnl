// Unit proof for the FIFO cost-layer mutation helpers (feat/inventory-fifo-batch-edit-delete).
//
// No app test runner exists, so this transpiles batchMutations.ts at runtime via the
// repo's `typescript` devDep (matching src/lib/inventory/filterSkus.test.mjs) and
// exercises the REAL parseBatchEdit / buildSeedBatchRow / mapBatchRpcError.
//
// The DB RPCs are the source of truth for the rules; these cover the route-level
// input validation, the create-SKU SEED-batch shape (qty_added populated), and the
// RPC-error → HTTP mapping. The full behavioral rules are proven by the SQL harness
// in supabase/tests/batch_edit_delete/.
//
// Run:  node src/lib/inventory/batchMutations.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./batchMutations.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'batchmut-')), 'batchMutations.mjs');
writeFileSync(outFile, outputText);
const { parseBatchEdit, buildSeedBatchRow, mapBatchRpcError, deriveBatchQuantities, parseFinalizeCost } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── parseBatchEdit (second arg = costProvided: was the field present?) ──────────
{
  const ok = parseBatchEdit({ qty_remaining: 5, unit_cost_cents: 250 }, true);
  check('valid qty + cost parses (set_cost true)', ok.ok && ok.value.qty_remaining === 5 && ok.value.unit_cost_cents === 250 && ok.value.set_cost === true);

  const zero = parseBatchEdit({ qty_remaining: 0, unit_cost_cents: 0 }, true);
  check('qty 0 and cost 0 are valid', zero.ok && zero.value.qty_remaining === 0 && zero.value.unit_cost_cents === 0);

  const strs = parseBatchEdit({ qty_remaining: '12', unit_cost_cents: '999' }, true);
  check('numeric strings coerce', strs.ok && strs.value.qty_remaining === 12 && strs.value.unit_cost_cents === 999);

  // Explicit null/blank cost WITH the field present ⇒ set cost to unknown (null).
  const blankCost = parseBatchEdit({ qty_remaining: 3, unit_cost_cents: '' }, true);
  check('explicit blank cost ⇒ null + set_cost true', blankCost.ok && blankCost.value.unit_cost_cents === null && blankCost.value.set_cost === true);
  const nullCost = parseBatchEdit({ qty_remaining: 3, unit_cost_cents: null }, true);
  check('explicit null cost ⇒ null + set_cost true', nullCost.ok && nullCost.value.unit_cost_cents === null && nullCost.value.set_cost === true);

  // OMITTED cost field (costProvided false) ⇒ set_cost false, cost left alone.
  const omitted = parseBatchEdit({ qty_remaining: 3, unit_cost_cents: undefined }, false);
  check('omitted cost ⇒ set_cost false (cost untouched)', omitted.ok && omitted.value.set_cost === false);
  // An omitted cost is not validated at all — even a garbage value is ignored.
  const omittedGarbage = parseBatchEdit({ qty_remaining: 3, unit_cost_cents: 'nonsense' }, false);
  check('omitted cost not validated (garbage ignored)', omittedGarbage.ok && omittedGarbage.value.set_cost === false);

  check('negative qty rejected', parseBatchEdit({ qty_remaining: -1, unit_cost_cents: 100 }, true).ok === false);
  check('fractional qty rejected', parseBatchEdit({ qty_remaining: 3.5, unit_cost_cents: 100 }, true).ok === false);
  check('non-numeric qty rejected', parseBatchEdit({ qty_remaining: 'x', unit_cost_cents: 100 }, true).ok === false);
  check('blank qty rejected', parseBatchEdit({ qty_remaining: '', unit_cost_cents: 100 }, true).ok === false);
  check('qty still required when cost omitted', parseBatchEdit({ qty_remaining: -1 }, false).ok === false);
  check('negative cost rejected (when provided)', parseBatchEdit({ qty_remaining: 3, unit_cost_cents: -5 }, true).ok === false);
  check('fractional cost rejected (when provided)', parseBatchEdit({ qty_remaining: 3, unit_cost_cents: 2.5 }, true).ok === false);
}

// ── buildSeedBatchRow (create-SKU seed layer) ───────────────────────────────────
{
  const row = buildSeedBatchRow({ userId: 'u1', skuId: 's1', qtyOnHand: 7, unitCostCents: 500 });
  check('seed populates qty_added = starting qty', row.qty_added === 7 && row.qty_remaining === 7,
    `qty_added=${row.qty_added} qty_remaining=${row.qty_remaining}`);
  check('seed qty_added === qty_remaining (untouched by construction)', row.qty_added === row.qty_remaining);
  check('seed sequence is 1', row.sequence === 1);
  check('seed carries user/sku/cost', row.user_id === 'u1' && row.sku_id === 's1' && row.unit_cost_cents === 500);

  const zero = buildSeedBatchRow({ userId: 'u', skuId: 's', qtyOnHand: null, unitCostCents: null });
  check('null starting qty ⇒ 0 (and qty_added 0)', zero.qty_remaining === 0 && zero.qty_added === 0);
  check('null cost ⇒ null', zero.unit_cost_cents === null);

  // ── migration 149: the seed layer must assert both new facts ──
  check('seed marks qty_added authoritative', row.qty_added_authoritative === true);
  check('seed with a cost ⇒ cost_status final', row.cost_status === 'final');
  check('seed with NO cost ⇒ cost_status pending', zero.cost_status === 'pending');
  check('pending seed leaves unit_cost_cents null (149 CHECK invariant)',
    zero.cost_status === 'pending' && zero.unit_cost_cents === null);
  const free = buildSeedBatchRow({ userId: 'u', skuId: 's', qtyOnHand: 3, unitCostCents: 0 });
  check('GENUINE $0 seed ⇒ final, not pending — the 149 distinction',
    free.cost_status === 'final' && free.unit_cost_cents === 0);
}

// ── deriveBatchQuantities — Received / Remaining / Consumed (migration 149) ─────
// Consumed is DERIVED (qty_added − qty_remaining) and is only a number when qty_added
// is provably the layer's original quantity. These cases mirror the SQL harness's
// Tests I/K/L so both ends of the seam agree.
{
  const auth = (qty_added, qty_remaining) =>
    deriveBatchQuantities({ qty_added, qty_remaining, qty_added_authoritative: true });

  const a = auth(500, 380);
  check('authoritative: ADDED survives consumption', a.added === 500);
  check('authoritative: remaining is current stock', a.remaining === 380);
  check('authoritative: consumed = added − remaining', a.consumed === 120);

  const fresh = auth(400, 400);
  check('untouched layer ⇒ consumed 0', fresh.consumed === 0 && fresh.added === 400);

  const empty = auth(500, 0);
  check('fully drawn layer ⇒ consumed = added', empty.consumed === 500 && empty.remaining === 0);

  const over = auth(10, -4);
  check('oversold layer ⇒ consumed exceeds added', over.consumed === 14 && over.remaining === -4);

  // Legacy rows: qty_added may be NULL, or may have been re-based by a pre-150 edit.
  // Report null rather than a plausible-looking wrong number.
  const legacyNull = deriveBatchQuantities({ qty_added: null, qty_remaining: 12, qty_added_authoritative: false });
  check('legacy NULL qty_added ⇒ added/consumed null', legacyNull.added === null && legacyNull.consumed === null);
  check('legacy still reports remaining', legacyNull.remaining === 12);

  const legacyNumeric = deriveBatchQuantities({ qty_added: 50, qty_remaining: 12, qty_added_authoritative: false });
  check('legacy NUMERIC qty_added is NOT trusted as a receipt',
    legacyNumeric.added === null && legacyNumeric.consumed === null);

  const preFlag = deriveBatchQuantities({ qty_added: 50, qty_remaining: 12 });
  check('absent flag (pre-149 payload) is treated as legacy',
    preFlag.added === null && preFlag.consumed === null);

  const flaggedButNull = deriveBatchQuantities({ qty_added: null, qty_remaining: 5, qty_added_authoritative: true });
  check('authoritative but NULL qty_added ⇒ null, never NaN',
    flaggedButNull.added === null && flaggedButNull.consumed === null);
}

// ── parseFinalizeCost — the ONE cost-change input (migration 151) ───────────────
// Unlike parseBatchEdit, a cost is REQUIRED: "finalize" means asserting a number.
{
  const ok = parseFinalizeCost(340);
  check('finalize accepts cents', ok.ok === true && ok.value.unit_cost_cents === 340);
  const zero = parseFinalizeCost(0);
  check('finalize accepts a GENUINE 0 (free inventory is a real cost)',
    zero.ok === true && zero.value.unit_cost_cents === 0);
  const str = parseFinalizeCost('355');
  check('finalize accepts a numeric string', str.ok === true && str.value.unit_cost_cents === 355);

  check('finalize REJECTS blank — that is what leaving it pending means', parseFinalizeCost('').ok === false);
  check('finalize REJECTS null', parseFinalizeCost(null).ok === false);
  check('finalize REJECTS undefined', parseFinalizeCost(undefined).ok === false);
  check('finalize REJECTS negative', parseFinalizeCost(-1).ok === false);
  check('finalize REJECTS fractional cents', parseFinalizeCost(3.5).ok === false);
  check('finalize REJECTS non-numeric', parseFinalizeCost('abc').ok === false);
  check('blank-cost message points at pending, not at an error',
    /pending/i.test(parseFinalizeCost('').error));
}

// ── mapBatchRpcError ────────────────────────────────────────────────────────────
{
  check('BATCH_NOT_FOUND → 404', mapBatchRpcError('… BATCH_NOT_FOUND …').status === 404);
  check('INVALID_QTY → 400', mapBatchRpcError('INVALID_QTY').status === 400);
  check('INVALID_COST → 400', mapBatchRpcError('INVALID_COST').status === 400);
  const notDeletable = mapBatchRpcError('BATCH_NOT_DELETABLE');
  check('BATCH_NOT_DELETABLE → 409 + edit-to-zero hint', notDeletable.status === 409 && /remaining quantity to 0/i.test(notDeletable.error));
  const last = mapBatchRpcError('CANNOT_DELETE_LAST_BATCH');
  check('CANNOT_DELETE_LAST_BATCH → 409 + only-layer hint', last.status === 409 && /only cost layer/i.test(last.error));
  check('NO_ORG → 403', mapBatchRpcError('NO_ORG').status === 403);
  check('NOT_AUTHENTICATED → 401', mapBatchRpcError('NOT_AUTHENTICATED').status === 401);
  // ── migration 151 tokens: no raw Postgres error may reach a user ──
  const consumed = mapBatchRpcError('BATCH_HAS_CONSUMPTION');
  check('BATCH_HAS_CONSUMPTION → 409, not 500', consumed.status === 409);
  check('…and says the stock was used in sales', /used in sales/i.test(consumed.error));
  const needsFinalize = mapBatchRpcError('COST_EDIT_REQUIRES_FINALIZE');
  check('COST_EDIT_REQUIRES_FINALIZE → 409 pointing at Enter cost',
    needsFinalize.status === 409 && /Enter cost/i.test(needsFinalize.error));
  const notAttr = mapBatchRpcError('BATCH_NOT_ATTRIBUTABLE');
  check('BATCH_NOT_ATTRIBUTABLE → 409 explaining legacy layers',
    notAttr.status === 409 && /pre-dates/i.test(notAttr.error));
  check('COST_REQUIRED → 400', mapBatchRpcError('COST_REQUIRED').status === 400);
  // The FK is the last line of defence; if it ever fires, it must NOT surface as a 500.
  const rawFk = mapBatchRpcError(
    'insert or update on table "live_auction_item_skus" violates foreign key constraint "live_auction_item_skus_source_batch_id_fkey"');
  check('raw 23503 FK text → 409, never a generic 500', rawFk.status === 409);
  check('…with the same friendly wording', /used in sales/i.test(rawFk.error));

  check('unknown → 500', mapBatchRpcError('some random pg error').status === 500);
  check('null message → 500', mapBatchRpcError(null).status === 500);
}

console.log(`\n✅ batchMutations: ${passed} checks passed`);
