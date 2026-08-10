// Proof for the weekly-OT claim boundary. 40h is straight time, not overtime: claims auto-approve
// at <= 40 and go pending only at > 40. Transpiles otGate.ts (no imports) at runtime.
// Run:  node src/lib/schedule/otGate.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./otGate.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'ot-')), 'otGate.mjs');
writeFileSync(outFile, outputText);
const { claimAutoApproves, OT_THRESHOLD_HOURS } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

console.log('\nOT claim boundary (auto-approve <= 40, pending > 40)');
check('OT_THRESHOLD_HOURS is 40', OT_THRESHOLD_HOURS === 40);

// The three required cases from the spec — the primary use case lands exactly on 40 and must NOT
// go to the (UI-less) pending queue.
check('fulfillment 32h + 8h shift = 40 → AUTO-APPROVE', claimAutoApproves(32 + 8) === true, 'projected=40');
check('host 30h + 10h shift = 40 → AUTO-APPROVE', claimAutoApproves(30 + 10) === true, 'projected=40');
check('fulfillment 40h + 8h shift = 48 → PENDING', claimAutoApproves(40 + 8) === false, 'projected=48');

// Boundary: exactly 40 auto-approves; anything strictly above does not.
check('exactly 40 → auto-approve', claimAutoApproves(40) === true);
check('40.5 → pending', claimAutoApproves(40.5) === false);
check('41 → pending', claimAutoApproves(41) === false);
check('under 40 (39.99) → auto-approve', claimAutoApproves(39.99) === true);

console.log(`\nALL PASSED (${passed} assertions)`);
