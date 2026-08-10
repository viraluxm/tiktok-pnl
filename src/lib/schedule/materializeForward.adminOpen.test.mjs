// Proof that the FORWARD MATERIALIZER never touches admin one-time shifts (migration 090).
//
// The runner (runForwardMaterializer) only ever INSERTs planForwardInstances() output with
// ON CONFLICT (employee_id, shift_date) DO NOTHING — it never UPDATEs or DELETEs. So "never
// touches admin_open" reduces to two pure facts about the planner, asserted here:
//   1. Every planned row is source 'pattern' with a shift_rule_id and a non-null employee_id — the
//      planner can NEVER emit an admin_open row (admin_open has shift_rule_id NULL / may be
//      unassigned), so a materializer run can't create or overwrite one.
//   2. An ASSIGNED admin shift on (emp, date) is an existing (employee_id, shift_date) key, so a
//      rule that would land on that same key is a conflict-skip — the admin row is left intact.
// An UNASSIGNED admin shift has employee_id NULL: it isn't an existing key (NULLs distinct, like the
// DB UNIQUE), and the planner's inserts always carry a non-null employee_id, so the two can never
// collide. Transpiles timezone.ts + materializeForward.ts (same rig as the dry-run script).
// Run:  TZ=UTC node src/lib/schedule/materializeForward.adminOpen.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'mfao-'));
function transpileTo(srcRel, outName, rewrite = (s) => s) {
  const src = readFileSync(new URL(`./${srcRel}`, import.meta.url), 'utf8');
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

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const TODAY = '2026-08-14';
const mkRule = (id, emp, dows, start, end, created, start_date = '2026-01-01') => ({
  id, user_id: 'u1', employee_id: emp, days_of_week: dows,
  start_time: start, end_time: end, start_date, active: true, store_id: null, created_at: created,
});

// One host rule on Sat (Aug 15) + Sun (Aug 16).
const rules = [mkRule('r-adriana', 'adriana', [6, 0], '16:00', '02:00', '2026-01-01T00:00:00Z')];

console.log('\nmaterializer output can never BE an admin_open row');
{
  const plan = planForwardInstances({ rules, existing: [], guardKeys: new Set(), today: TODAY, horizonDays: 9 });
  check('produced some pattern instances', plan.to_insert.length >= 2, `n=${plan.to_insert.length}`);
  check('every planned row is source pattern', plan.to_insert.every((r) => r.source === 'pattern'));
  check('every planned row has a shift_rule_id', plan.to_insert.every((r) => !!r.shift_rule_id));
  check('every planned row has a non-null employee_id', plan.to_insert.every((r) => !!r.employee_id));
}

console.log('\nan ASSIGNED admin shift on the same (emp,date) is a conflict-skip (left intact)');
{
  // Adriana has an admin-assigned shift on Sat Aug 15 already (an existing employee_id/date key).
  const existing = [{ employee_id: 'adriana', shift_date: '2026-08-15' }];
  const plan = planForwardInstances({ rules, existing, guardKeys: new Set(), today: TODAY, horizonDays: 9 });
  check('Aug 15 is NOT re-planned (conflict-skip)', !plan.to_insert.some((r) => r.employee_id === 'adriana' && r.shift_date === '2026-08-15'));
  check('at least one conflict skip counted', plan.skipped_by_conflict >= 1, `skips=${plan.skipped_by_conflict}`);
  check('the OTHER day (Aug 16) still planned normally', plan.to_insert.some((r) => r.employee_id === 'adriana' && r.shift_date === '2026-08-16'));
}

console.log('\nan UNASSIGNED admin shift (employee_id NULL) never blocks and is never collided-with');
{
  // Unassigned admin_open on Aug 15 → employee_id NULL. Like the DB UNIQUE (NULLs distinct), it is
  // NOT an existing key, so the rule still plans Adriana's Aug 15 shift; and since every planned row
  // carries a non-null employee_id, the plan can never target the NULL-employee admin row.
  const existing = [{ employee_id: null, shift_date: '2026-08-15' }];
  const plan = planForwardInstances({ rules, existing, guardKeys: new Set(), today: TODAY, horizonDays: 9 });
  check('unassigned admin row does NOT suppress the rule', plan.to_insert.some((r) => r.employee_id === 'adriana' && r.shift_date === '2026-08-15'));
  check('no conflict skip from a NULL-employee existing row', plan.skipped_by_conflict === 0, `skips=${plan.skipped_by_conflict}`);
}

console.log(`\nALL PASSED (${passed} assertions)`);
