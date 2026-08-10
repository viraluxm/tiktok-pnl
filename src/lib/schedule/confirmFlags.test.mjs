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
// Defaults: in-schedule-era unless overridden.
const F = (o) => computeConfirmFlags({ clockedHours: 0, breakMinutes: 0, scheduled: null, employeeHasRules: false, scheduleAppliesToDate: true, ...o });

console.log('\nconfirm flags — schedule-relative (in era)');
{
  const f = F({ clockedHours: 34.2, scheduled: S(10), employeeHasRules: true });
  check('34.2h vs 10h → over_span warn', kinds(f).includes('over_span') && f.find((x) => x.kind === 'over_span').severity === 'warn');
  check('over_span message shows comparison', /clocked 34\.2h, scheduled 10h/.test(f.find((x) => x.kind === 'over_span').message));
}
check('15h vs 10h → over_span (via >3h rule)', kinds(F({ clockedHours: 15, scheduled: S(10), employeeHasRules: true })).includes('over_span'));
check('12h vs 10h → no schedule-relative flag', F({ clockedHours: 12, scheduled: S(10), employeeHasRules: true }).length === 0);
check('4h vs 10h → under_span note', F({ clockedHours: 4, scheduled: S(10), employeeHasRules: true }).some((x) => x.kind === 'under_span' && x.severity === 'note'));
check('no span + HAS rules + in era → unscheduled_day', kinds(F({ clockedHours: 8, scheduled: null, employeeHasRules: true })).includes('unscheduled_day'));
check('no span + NO rules → not flagged', F({ clockedHours: 8, scheduled: null, employeeHasRules: false }).length === 0);

console.log('\nlong break (schedule-independent)');
check('break 120m → long_break', kinds(F({ clockedHours: 8, breakMinutes: 120, scheduled: S(8), employeeHasRules: true })).includes('long_break'));
check('break 90m → no long_break (boundary)', !kinds(F({ clockedHours: 8, breakMinutes: 90, scheduled: S(8), employeeHasRules: true })).includes('long_break'));

console.log('\nimplausible span (schedule-INDEPENDENT, >14h, any era / no schedule)');
check('20h, no span, no rules, out of era → implausible_span only', kinds(F({ clockedHours: 20, employeeHasRules: false, scheduleAppliesToDate: false })).join(',') === 'implausible_span');
check('14h exactly → no implausible (boundary, not >14)', !kinds(F({ clockedHours: 14, scheduled: S(10), employeeHasRules: true })).includes('implausible_span'));
check('14.1h → implausible_span', kinds(F({ clockedHours: 14.1, employeeHasRules: false, scheduleAppliesToDate: false })).includes('implausible_span'));
// The Aug-8 forgotten clock-out, pre-schedule: implausible fires, schedule-relative suppressed.
check('33.5h pre-era (has rules) → implausible_span ONLY (over/unscheduled suppressed)',
  kinds(F({ clockedHours: 33.5, scheduled: null, employeeHasRules: true, scheduleAppliesToDate: false })).join(',') === 'implausible_span');
// In-era 34h with a scheduled span → both implausible AND over.
check('34h in-era vs 8h → implausible_span + over_span', kinds(F({ clockedHours: 34, scheduled: S(8), employeeHasRules: true })).join(',') === 'implausible_span,over_span');

console.log('\nera suppression (dates before earliest active-rule start_date)');
// Adriana Aug 9 case: 9.1h, has rules, pre-era, no long break → CLEAN.
check('9.1h pre-era, has rules, no long break → NO flags', F({ clockedHours: 9.1, scheduled: null, employeeHasRules: true, scheduleAppliesToDate: false }).length === 0);
check('pre-era still allows long_break', kinds(F({ clockedHours: 9, breakMinutes: 120, employeeHasRules: true, scheduleAppliesToDate: false })).join(',') === 'long_break');
check('pre-era suppresses over_span even with a (stale) span present', !kinds(F({ clockedHours: 30, scheduled: S(8), employeeHasRules: true, scheduleAppliesToDate: false })).includes('over_span'));

console.log(`\nALL PASSED (${passed} assertions)`);
