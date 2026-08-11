// Proof for the public /s render plan (planSchedulePage): the page must render from what actually
// exists, NEVER gate on hasActiveRules(). These are the exact scenarios from the gate-bug fix — a
// no-rules employee must still see an assigned one-time shift or a claimable board shift. Transpiles
// scheduleView.ts (no imports) at runtime — same pattern as eligibility.test.mjs.
// Run:  node src/lib/schedule/scheduleView.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./scheduleView.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'schedview-')), 'scheduleView.mjs');
writeFileSync(outFile, outputText);
const { planSchedulePage } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nplanSchedulePage — render what exists, never gate on rules');

// 1. No rules + a one-time shift assigned directly → it shows under Your shifts (with its Release
//    button in the page). This is the case the hasActiveRules gate used to hide entirely.
{
  const p = planSchedulePage({ myShifts: 1, board: 0, pending: 0 });
  check('assigned one-time shift, no rules → Your shifts renders', !p.isEmpty && eq(p.sections, ['yours']));
}

// 2. No rules + a matching-role board shift → the board renders (with its Claim button).
{
  const p = planSchedulePage({ myShifts: 0, board: 1, pending: 0 });
  check('claimable board shift, no rules → Open shifts renders', !p.isEmpty && eq(p.sections, ['open']));
}

// 3. No rules + nothing at all → the single empty state, no sections.
{
  const p = planSchedulePage({ myShifts: 0, board: 0, pending: 0 });
  check('nothing pending → empty state', p.isEmpty && eq(p.sections, []));
}

// 4. Has rules (⇒ has upcoming shifts) → unchanged: Your shifts renders; board leads when present.
{
  const only = planSchedulePage({ myShifts: 3, board: 0, pending: 0 });
  check('has shifts, empty board → only Your shifts (no board placeholder)', eq(only.sections, ['yours']));
  const both = planSchedulePage({ myShifts: 3, board: 2, pending: 0 });
  check('has shifts + non-empty board → board leads, then Your shifts', eq(both.sections, ['open', 'yours']));
}

console.log('\nordering + section omission');

// A non-empty board leads over the schedule; an empty board is omitted (no placeholder).
check('board-first ordering', eq(planSchedulePage({ myShifts: 2, board: 1, pending: 0 }).sections, ['open', 'yours']));
check('empty board omitted', eq(planSchedulePage({ myShifts: 2, board: 0, pending: 0 }).sections, ['yours']));
check('empty your-shifts omitted', eq(planSchedulePage({ myShifts: 0, board: 3, pending: 0 }).sections, ['open']));

// An in-flight OT claim always leads.
check('pending leads, alone', eq(planSchedulePage({ myShifts: 0, board: 0, pending: 1 }).sections, ['pending']));
check('pending leads, full house', eq(planSchedulePage({ myShifts: 2, board: 1, pending: 1 }).sections, ['pending', 'open', 'yours']));
check('pending + only shifts', eq(planSchedulePage({ myShifts: 2, board: 0, pending: 1 }).sections, ['pending', 'yours']));

// Not-empty as long as ANY section has content (pending alone keeps the page out of the empty state).
check('pending alone is not the empty state', planSchedulePage({ myShifts: 0, board: 0, pending: 2 }).isEmpty === false);

console.log(`\n${passed} checks passed\n`);
