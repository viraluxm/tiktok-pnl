// Dry-run demo for the forward schedule materializer (post-086: single schedule model).
// Transpiles the REAL planner (planForwardInstances) + timezone helpers at runtime and runs a
// representative fixture — no DB, no writes. Proves multi-element days_of_week expansion, the
// (employee_id, shift_date) regeneration guard, conflict-skip, overnight roll (incl. midnight end),
// and LA→UTC conversion. Run:  TZ=UTC node scripts/dryrun-forward-materializer.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'fwd-'));
function transpileTo(srcRel, outName, rewrite = (s) => s) {
  const src = readFileSync(new URL(`../src/lib/schedule/${srcRel}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const out = join(dir, outName);
  writeFileSync(out, rewrite(outputText));
  return out;
}
transpileTo('timezone.ts', 'timezone.mjs');
const mfPath = transpileTo('materializeForward.ts', 'mf.mjs', (s) => s.replaceAll('./timezone', './timezone.mjs'));
const { planForwardInstances } = await import(pathToFileURL(mfPath).href);

// Fixture: LA today fixed to Fri 2026-08-14. Rules carry multi-element days_of_week directly.
const TODAY = '2026-08-14';
const mkRule = (id, emp, dows, start, end, created, start_date = '2026-01-01') => ({
  id, user_id: 'u1', employee_id: emp, days_of_week: dows,
  start_time: start, end_time: end, start_date, active: true, store_id: null, created_at: created,
});

const rules = [
  // Host, Sat+Sun, overnight 16:00→02:00 (10h).
  mkRule('r-adriana', 'adriana', [6, 0], '16:00', '02:00', '2026-01-01T00:00:00Z'),
  // Host, Sat, overnight 16:00→00:00 midnight-end edge (8h).
  mkRule('r-jacky', 'jacky', [6], '16:00', '00:00', '2026-01-02T00:00:00Z'),
  // Fulfillment, Mon–Fri day shift 06:00→14:00 (8h).
  mkRule('r-carlos', 'carlos', [1, 2, 3, 4, 5], '06:00', '14:00', '2026-01-01T00:00:00Z'),
];

// Adriana released next Saturday (Aug 15) → an attendance guard row (employee_id, shift_date).
const guardKeys = new Set(['adriana|2026-08-15']);
// Carlos already has a materialized instance for Mon Aug 17 (conflict-skip).
const existing = [{ employee_id: 'carlos', shift_date: '2026-08-17' }];

const plan = planForwardInstances({ rules, existing, guardKeys, today: TODAY, horizonDays: 9 });

console.log('=== FORWARD MATERIALIZER DRY-RUN (fixture, post-086) ===');
console.log(`today=${plan.today}  window=${plan.window.from}..${plan.window.to}`);
console.log(`rules_processed=${plan.rules_processed} candidates=${plan.candidates}`);
console.log(`to_insert=${plan.to_insert.length} skipped_guard=${plan.skipped_by_guard} skipped_conflict=${plan.skipped_by_conflict}`);
console.log('\nWOULD INSERT (emp / rule / date / starts_at → ends_at):');
for (const r of plan.to_insert) {
  console.log(`  ${r.employee_id.padEnd(8)} ${r.shift_rule_id.padEnd(10)} ${r.shift_date}  ${r.starts_at} → ${r.ends_at}`);
}
