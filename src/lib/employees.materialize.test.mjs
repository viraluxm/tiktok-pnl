// In-memory exactly-once proof for recurring-shift materialization (migration 055).
// No app test runner exists, so this self-contained file transpiles employees.ts at
// runtime via the repo's `typescript` devDep (its only import is type-only, erased) and
// exercises the REAL generateRecurringShifts / pastInstancesToMaterialize / computePay.
//
// Run:  TZ=UTC node src/lib/employees.materialize.test.mjs
//
// Proves: materializing past recurring days does NOT double-count, history survives a rule
// delete (source_rule_id → NULL) and a pattern edit, and — the fragile part — 'skip'
// exceptions never materialize while 'modified' exceptions materialize with their OVERRIDDEN
// hours.
//
// REWRITTEN FOR DEPLOY C ("punches are truth, schedule is plan", PR #142). Three scenarios
// used to prove exactly-once by asserting a PAY TOTAL was unchanged after materialization.
// That proof is no longer available: isPayableShift now returns false for any row with
// source_rule_id, so a materialized row contributes 0 to pay whether it is double-counted or
// not — the old assertions failed against correct code and took scenarios B, C and D down
// with them, leaving the fragile exception handling untested.
//
// Exactly-once is now proved where it actually lives — the generator excluding every
// materialized day — and the pay contract is asserted DIRECTLY, including the discrimination
// that matters: the same days pay 240h as manual corrections and 0h as plan.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

// ── Load the real employees.ts (transpile TS → ESM; type-only import is stripped).
const srcPath = fileURLToPath(new URL('./employees.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'emp-')), 'employees.mjs');
writeFileSync(outFile, outputText);
const { generateRecurringShifts, pastInstancesToMaterialize, computePay } =
  await import(pathToFileURL(outFile).href);

// ── Fixtures. today = Sun 2026-07-12 (a NON-workday) so there is no "today" projection
// muddying past-vs-total comparisons. Rule = Mon–Fri 09:00–17:00 (8h) from 2026-06-01.
const TODAY = new Date(2026, 6, 12); // local; run under TZ=UTC for determinism
const EMP = { id: 'emp-1', hourly_rate: 10 };
const rule = {
  id: 'rule-1', user_id: 'u1', employee_id: 'emp-1',
  days_of_week: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00',
  start_date: '2026-06-01', active: true, store_id: null,
};

const totalHours = (shiftsLike) => computePay([EMP], shiftsLike)[0].hours;
// Turn materializable instances into real `shifts` rows (concrete end_time, source set).
const toRows = (instances, sourceNull = false) =>
  instances.map((i) => ({
    employee_id: i.employee_id, date: i.date,
    start_time: i.start_time, end_time: i.end_time,
    source_rule_id: sourceNull ? null : i.rule_id,
  }));

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO A — exactly-once (no exceptions)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSCENARIO A — exactly-once, no exceptions');
{
  const genBefore = generateRecurringShifts([rule], [], null, null, new Set(), TODAY);
  const before = totalHours(genBefore.filter((g) => !g.skipped));

  const instances = pastInstancesToMaterialize([rule], [], new Set(), TODAY);
  const rows = toRows(instances);
  const materialized = new Set(instances.map((i) => `${i.rule_id}|${i.date}`));

  const genAfter = generateRecurringShifts([rule], [], null, null, materialized, TODAY);
  const after = totalHours([...rows, ...genAfter.filter((g) => !g.skipped)]);

  check('30 past workdays projected', instances.length === 30, `got ${instances.length}`);
  check('before = 240h (30×8)', before === 240, `got ${before}`);
  check('generator excludes ALL materialized past days', genAfter.length === 0, `got ${genAfter.length}`);
  // Exactly-once is proved by the exclusion check above: 30 days projected, 30 materialized,
  // 0 still projected. Nothing can be counted twice because nothing is offered twice.
  //
  // The pay contract, asserted directly rather than inferred from a total:
  check('materialized PLAN rows contribute nothing to pay', after === 0, `got ${after}`);
  check('...and that is because they are plan, not because the rows are empty',
    rows.length === 30 && rows.every((r) => r.source_rule_id === 'rule-1'),
    `${rows.length} rows`);
  // The discriminating case. The very same 30 days, as manual corrections (source_rule_id
  // NULL), DO pay — so the guard keys on plan-ness and not on something incidental to these
  // rows. Without this, `after === 0` would also pass if pay were simply broken.
  check('the SAME days as manual corrections pay the full 240h',
    totalHours(toRows(instances, true)) === 240, `got ${totalHours(toRows(instances, true))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO B — history survives rule delete (source_rule_id → NULL)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSCENARIO B — rule deleted → rows become plain one-offs (SET NULL)');
{
  const before = totalHours(
    generateRecurringShifts([rule], [], null, null, new Set(), TODAY).filter((g) => !g.skipped),
  );
  const instances = pastInstancesToMaterialize([rule], [], new Set(), TODAY);
  const rowsNulled = toRows(instances, /* sourceNull */ true); // rule gone
  // No rules remain → generator produces nothing; only the frozen rows count.
  const afterDelete = totalHours([...rowsNulled, ...generateRecurringShifts([], [], null, null, new Set(), TODAY)]);
  check('past hours REMAIN after delete', afterDelete === before, `before=${before} afterDelete=${afterDelete}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO C — pattern edit does not alter frozen history
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSCENARIO C — edit rule pattern; frozen past rows unchanged');
{
  const instances = pastInstancesToMaterialize([rule], [], new Set(), TODAY);
  const rows = toRows(instances);
  // Valued as corrections, since as plan rows they are worth 0 by contract and a pay total
  // could no longer detect whether the edit had altered them.
  const frozen = totalHours(toRows(instances, true)); // 240h, snapshotted at 8h/day

  const editedRule = { ...rule, start_time: '09:00', end_time: '12:00' }; // 8h → 3h going forward
  const materialized = new Set(instances.map((i) => `${i.rule_id}|${i.date}`));
  const genEdited = generateRecurringShifts([editedRule], [], null, null, materialized, TODAY);
  const afterEdit = totalHours([...rows, ...genEdited.filter((g) => !g.skipped)]);

  check('edited rule projects NOTHING for materialized past', genEdited.length === 0, `got ${genEdited.length}`);
  // The real invariant: the frozen ROWS keep the span they were written with. The rule now
  // says 3h; history must still say 8h.
  check('frozen rows keep the ORIGINAL 09:00–17:00 span, not the edited 12:00',
    rows.length === 30 && rows.every((r) => r.start_time === '09:00' && r.end_time === '17:00'));
  check('worth 240h as corrections — the edit did not rewrite history',
    frozen === 240, `frozen=${frozen}`);
  check('and still 0 as plan rows, before and after the edit', afterEdit === 0, `got ${afterEdit}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO D — EXCEPTIONS (the fragile case): skip must not materialize; modified must
// materialize with OVERRIDDEN hours.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSCENARIO D — exceptions: skip excluded, modified uses overridden hours');
{
  const skip = { rule_id: 'rule-1', date: '2026-07-06', type: 'skip', modified_start: null, modified_end: null };      // Mon, 8h removed
  const modified = { rule_id: 'rule-1', date: '2026-07-07', type: 'modified', modified_start: '09:00', modified_end: '13:00' }; // Tue, 8h → 4h
  const exceptions = [skip, modified];

  const before = totalHours(
    generateRecurringShifts([rule], exceptions, null, null, new Set(), TODAY).filter((g) => !g.skipped),
  );
  const instances = pastInstancesToMaterialize([rule], exceptions, new Set(), TODAY);
  const skipRow = instances.find((i) => i.date === '2026-07-06');
  const modRow = instances.find((i) => i.date === '2026-07-07');
  const rows = toRows(instances);
  const materialized = new Set(instances.map((i) => `${i.rule_id}|${i.date}`));
  const after = totalHours([
    ...rows,
    ...generateRecurringShifts([rule], exceptions, null, null, materialized, TODAY).filter((g) => !g.skipped),
  ]);

  check('projected total = 228h (240 − 8 skip − 4 modified)', before === 228, `got ${before}`);
  check("'skip' day is NOT materialized (no row)", skipRow === undefined);
  check('materialized row count = 29 (30 workdays − 1 skip)', instances.length === 29, `got ${instances.length}`);
  check("'modified' day materializes with OVERRIDDEN end_time 13:00 (not 17:00)",
    modRow && modRow.end_time === '13:00', `got ${modRow && modRow.end_time}`);
  check('materialized plan rows (with exceptions) pay 0', after === 0, `got ${after}`);
  // Delete survival with exceptions still intact. 228h, NOT 240 — proving the skip stayed out
  // and the modified day carried its 4h override into frozen history.
  const afterDelete = totalHours(toRows(instances, true));
  check('past hours (with exceptions) REMAIN after delete, at 228h',
    afterDelete === 228, `got ${afterDelete}`);
}

console.log(`\nALL PASSED (${passed} assertions)`);
