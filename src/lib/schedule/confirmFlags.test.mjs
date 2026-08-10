// Proof for confirm-time validation flags. computeConfirmFlags is pure (only a TYPE import, erased),
// so transpile confirmFlags.ts alone. Run:  node src/lib/schedule/confirmFlags.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import ts from 'typescript';

const src = readFileSync(fileURLToPath(new URL('./confirmFlags.ts', import.meta.url)), 'utf8');
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const out = join(mkdtempSync(join(tmpdir(), 'cf-')), 'cf.mjs'); writeFileSync(out, outputText);
const { computeConfirmFlags } = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}`); passed++; };
const kinds = (f) => f.map((x) => x.kind).sort();
const S = (h) => ({ hours: h, source: 'rule' });

console.log('\nconfirm flags');
// Over-span: the 34h forgotten clock-out.
{
  const f = computeConfirmFlags({ clockedHours: 34.2, breakMinutes: 0, scheduled: S(10), employeeHasRules: true });
  check('34.2h vs 10h → over_span warn', f.length === 1 && f[0].kind === 'over_span' && f[0].severity === 'warn');
  check('message shows the comparison', /clocked 34\.2h, scheduled 10h/.test(f[0].message), f[0].message);
}
// >3h absolute rule catches a case the >50% rule alone misses (15 !> 15, but 15 > 13).
check('15h vs 10h → over_span (via >3h rule)', kinds(computeConfirmFlags({ clockedHours: 15, breakMinutes: 0, scheduled: S(10), employeeHasRules: true })).includes('over_span'));
// Within tolerance → no flag.
check('12h vs 10h → no flag (within 50% and 3h)', computeConfirmFlags({ clockedHours: 12, breakMinutes: 0, scheduled: S(10), employeeHasRules: true }).length === 0);
check('10h vs 10h → no flag', computeConfirmFlags({ clockedHours: 10, breakMinutes: 0, scheduled: S(10), employeeHasRules: true }).length === 0);
// Under-span: lower-weight note.
{
  const f = computeConfirmFlags({ clockedHours: 4, breakMinutes: 0, scheduled: S(10), employeeHasRules: true });
  check('4h vs 10h → under_span note (not warn)', f.length === 1 && f[0].kind === 'under_span' && f[0].severity === 'note');
}
check('5.5h vs 10h → no under flag (not < 50%)', computeConfirmFlags({ clockedHours: 5.5, breakMinutes: 0, scheduled: S(10), employeeHasRules: true }).length === 0);
// Long break.
check('break 120m → long_break note', kinds(computeConfirmFlags({ clockedHours: 8, breakMinutes: 120, scheduled: S(8), employeeHasRules: true })) .includes('long_break'));
check('break 90m → no long_break (boundary, not >90)', !kinds(computeConfirmFlags({ clockedHours: 8, breakMinutes: 90, scheduled: S(8), employeeHasRules: true })).includes('long_break'));
// Unscheduled-day split.
check('no span + HAS rules → unscheduled_day warn', kinds(computeConfirmFlags({ clockedHours: 8, breakMinutes: 0, scheduled: null, employeeHasRules: true })).includes('unscheduled_day'));
check('no span + NO rules → NOT flagged (data-completeness, not per-shift)', computeConfirmFlags({ clockedHours: 8, breakMinutes: 0, scheduled: null, employeeHasRules: false }).length === 0);
// Combined.
check('over_span + long_break together', kinds(computeConfirmFlags({ clockedHours: 34, breakMinutes: 120, scheduled: S(10), employeeHasRules: true })).join(',') === 'long_break,over_span');

console.log(`\nALL PASSED (${passed} assertions)`);
