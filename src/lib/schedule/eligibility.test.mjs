// Proof for the admin-open shift kernels (migration 090): the role a released/open shift represents,
// the status+role plan for a one-time admin shift, and the overnight roll. Transpiles eligibility.ts
// (no imports) at runtime — same pattern as otGate.test.mjs.
// Run:  node src/lib/schedule/eligibility.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./eligibility.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'elig-')), 'eligibility.mjs');
writeFileSync(outFile, outputText);
const { effectiveShiftRole, planAdminShift, crossesMidnight } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

console.log('\neffectiveShiftRole — the role a board/claim shift represents');
// Released pattern shift: role comes from the RELEASER, NOT the (null) row role.
check('released shift → releaser role', effectiveShiftRole({ released_by: 'e1', source: 'claim', role: null }, 'host') === 'host');
check('released shift, releaser is fulfillment', effectiveShiftRole({ released_by: 'e2', source: 'pattern', role: null }, 'fulfillment') === 'fulfillment');
check('released shift, releaser unresolved → null', effectiveShiftRole({ released_by: 'e3', source: 'pattern', role: null }, null) === null);
// Admin open shift: no releaser → role is the row's OWN column.
check('admin_open unassigned → row role (host)', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'host' }, null) === 'host');
check('admin_open unassigned → row role (fulfillment)', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'fulfillment' }, null) === 'fulfillment');
// Malformed: released row with neither releaser nor admin_open source → not claimable.
check('released, no releaser, not admin_open → null', effectiveShiftRole({ released_by: null, source: 'pattern', role: null }, null) === null);
// A released admin_open row ignores any stray releaser lookup ordering: released_by wins first, but
// admin_open rows never have released_by, so this stays the row role.
check('admin_open never derives from a releaser', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'host' }, 'fulfillment') === 'host');

console.log('\nplanAdminShift — status + role for a one-time admin shift');
// Assigned: status scheduled; role = employee role; typed role ignored (no mismatch possible).
const a1 = planAdminShift({ employeeRole: 'host', role: null });
check('assigned → scheduled + employee role', a1.ok && a1.status === 'scheduled' && a1.role === 'host');
const a2 = planAdminShift({ employeeRole: 'fulfillment', role: 'host' });
check('assigned ignores typed role (uses employee)', a2.ok && a2.role === 'fulfillment', `got ${a2.role}`);
// Unassigned: status released; role required + must be a valid class.
const u1 = planAdminShift({ employeeRole: null, role: 'host' });
check('unassigned + host → released + host', u1.ok && u1.status === 'released' && u1.role === 'host');
const u2 = planAdminShift({ employeeRole: null, role: 'fulfillment' });
check('unassigned + fulfillment → released', u2.ok && u2.status === 'released' && u2.role === 'fulfillment');
const u3 = planAdminShift({ employeeRole: null, role: null });
check('unassigned + no role → ROLE_REQUIRED', !u3.ok && u3.error === 'ROLE_REQUIRED');
const u4 = planAdminShift({ employeeRole: null, role: 'manager' });
check('unassigned + invalid role → ROLE_REQUIRED', !u4.ok && u4.error === 'ROLE_REQUIRED');

console.log('\ncrossesMidnight — overnight roll');
check('09:00→17:00 same day', crossesMidnight('09:00', '17:00') === false);
check('22:00→02:00 overnight', crossesMidnight('22:00', '02:00') === true);
check('20:00→08:00 overnight', crossesMidnight('20:00', '08:00') === true);
// end == start is caller-rejected before this runs, but the predicate treats it as overnight (<=).
check('equal times → treated as overnight by <= (caller rejects first)', crossesMidnight('10:00', '10:00') === true);

console.log(`\nALL PASSED (${passed} assertions)`);
