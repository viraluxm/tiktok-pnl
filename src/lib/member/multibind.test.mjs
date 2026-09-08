// Proof for the squish over-bind flag (migration 129 + /api/member/audit/keep).
//
// flagReason is the LAST gate before a stock-moving write: keep/dismiss re-read the order's real
// lines and refuse when the flag does not hold. Every case below is one way that gate could be
// talked into unbinding an order it must not touch.
//
// Transpiles multibind.ts at runtime (no imports in it) — same pattern as eligibility.test.mjs.
// Run:  node src/lib/member/multibind.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./multibind.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'multibind-')), 'multibind.mjs');
writeFileSync(outFile, outputText);
const { flagReason, boundUnits } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const sq = (qty) => ({ qty, category: 'squish' });
const el = (qty) => ({ qty, category: 'electronics' });
const untagged = (qty) => ({ qty, category: null });

console.log('\nboundUnits — units, not lines, is the flag');
check('two lines of one', boundUnits([sq(1), sq(1)]) === 2);
check('ONE line of two (the same item scanned twice)', boundUnits([sq(2)]) === 2);
check('single unit', boundUnits([sq(1)]) === 1);
check('missing/garbage qty counts as zero, never NaN', boundUnits([{ qty: undefined }, { qty: 1 }]) === 1);

console.log('\nflagReason — null means "this IS an over-bind, proceed"');
check('two different squishes → flagged', flagReason([sq(1), sq(1)]) === null);
check('one squish, qty 2 → flagged (is_bundle is FALSE for this case)', flagReason([sq(2)]) === null);
check('three squishes → flagged', flagReason([sq(1), sq(1), sq(1)]) === null);

console.log('\nflagReason — refusals (each one is a write that must NOT happen)');
{
  const r = flagReason([sq(1)]);
  check('a correctly bound single order is refused', typeof r === 'string', r);
  check('...and says how many units it saw', r.includes('1 unit'), r);
}
{
  const r = flagReason([el(1), el(1)]);
  check('an electronics bundle is refused — those are REAL bundles', typeof r === 'string', r);
  check('...and names the category that put it out of scope', r.includes('electronics'), r);
}
check('mixed squish + electronics is refused', typeof flagReason([sq(1), el(1)]) === 'string');
check('untagged SKU is refused — we cannot claim it is a squish', typeof flagReason([sq(1), untagged(1)]) === 'string');
check('...and reports it as untagged, not as "null"', flagReason([sq(1), untagged(1)]).includes('untagged'));
check('an order with no lines is refused', typeof flagReason([]) === 'string');
check('zero units is refused, not treated as over-bound', typeof flagReason([{ qty: 0, category: 'squish' }]) === 'string');

console.log(`\n${passed} checks passed\n`);
