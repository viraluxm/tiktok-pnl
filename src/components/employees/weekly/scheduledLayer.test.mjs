// THE ACTIVE MANAGER SCHEDULE IS shift_instances-ONLY.
//
// ScheduleMonthCalendar used to build its "Scheduled" layer as (real instances ∪ recurring-rule
// projections), so a shift could be visible with no row behind it — un-editable, un-removable,
// un-clockable, and invisible to the Schedule Builder. This file is the guard that it never comes
// back, asserted three ways against the REAL component source:
//
//   1. the component does not import or call generateRecurringShifts
//   2. it does not read the rule/exception LISTS (only upsertException, for punch-row edits)
//   3. every row it can emit into the scheduled layer carries origin 'instance'
//
// A source-level assertion is the right tool here: the alternative is mounting a React tree with a
// live react-query client, which this repo has no harness for, and which would test the mock rather
// than the rule. Point 3 is additionally proved by replaying the component's own filter/mapping
// logic over a fixture that includes rule-shaped input.
//
// Run:  TZ=UTC node src/components/employees/weekly/scheduledLayer.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// Assert on CODE, not prose: these files explain in comments what they no longer do, and a naive
// grep would match the explanation. Strip block and line comments first.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const calendarRaw = read('./ScheduleMonthCalendar.tsx');
const calendar = code(calendarRaw);

console.log('\n1. the active manager calendar has no recurring projection');
{
  check('no generateRecurringShifts import', !/import\s*\{[^}]*generateRecurringShifts/.test(calendar));
  check('no generateRecurringShifts call', !/generateRecurringShifts\s*\(/.test(calendar));
  check("no origin: 'rule' row can be constructed", !/origin:\s*'rule'/.test(calendar));
  check('the removal IS documented in the source (a comment explains why, for the next reader)', /generateRecurringShifts/.test(calendarRaw));
  check("the scheduled layer sets origin: 'instance'", /origin:\s*'instance'/.test(calendar));
  // The rule/exception LISTS are what a projection needs. Only upsertException survives, and that
  // drives the shift editor's skip/modify actions for a rule-materialized `shifts` (punch) row.
  const hookLine = calendar.match(/const \{[^}]*\} = useShiftRules\(\);/)?.[0] ?? '';
  eq('useShiftRules yields ONLY upsertException', hookLine.replace(/\s+/g, ' '), 'const { upsertException } = useShiftRules();');
  check('rules/exceptions are not destructured anywhere', !/\brules\s*,|\bexceptions\s*[,}]/.test(hookLine));
}

console.log('\n2. the employee-facing surfaces are instance-only too');
{
  for (const [label, rel] of [
    ['MySchedule (/s week view)', '../../../app/s/[token]/MySchedule.tsx'],
    ['mySchedule server read', '../../../lib/schedule/mySchedule.ts'],
    ['EmployeeScheduleBuilder', '../schedule/EmployeeScheduleBuilder.tsx'],
    ['schedulePlan (the planner)', '../../../lib/schedule/schedulePlan.ts'],
    ['bulkSchedule (the write path)', '../../../lib/schedule/bulkSchedule.ts'],
  ]) {
    const src = code(read(rel));
    check(`${label}: no generateRecurringShifts`, !/generateRecurringShifts/.test(src));
    check(`${label}: no shift_rules / shift_exceptions read`, !/from\('shift_(rules|exceptions)'\)/.test(src));
  }
}

console.log('\n3. replaying the component\'s mapping over rule-shaped input yields nothing');
{
  // Extract the real scheduled-layer body from the component and run it. If someone re-adds a
  // projection loop, `generated` would be referenced and this would throw — which is the point.
  const body = calendar.match(/const scheduled: CalScheduled\[\] = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/);
  check('found the scheduled-layer useMemo in the real source', !!body);
  eq('its dependency list is ONLY instances (no rules/exceptions/generated)', body[2].trim(), 'instances');

  const dir = mkdtempSync(join(tmpdir(), 'schedlayer-'));
  const tsSrc = `
    const laWallClockOf = (iso) => ({ date: iso.slice(0, 10), time: iso.slice(11, 16) });
    export function build(instances) {
      const out = [];
      ${body[1].replace(/const out: CalScheduled\[\] = \[\];/, '')}
      return out;
    }`;
  const { outputText } = ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const f = join(dir, 'layer.mjs'); writeFileSync(f, outputText);
  const { build } = await import(pathToFileURL(f).href);

  const rows = [
    { id: 'a', employee_id: 'e1', shift_date: '2026-09-10', starts_at: '2026-09-10T13:00', ends_at: '2026-09-10T21:00', status: 'scheduled', source: 'admin_open', released_at: null },
    { id: 'b', employee_id: 'e1', shift_date: '2026-09-11', starts_at: '2026-09-11T13:00', ends_at: '2026-09-11T21:00', status: 'claimed', source: 'claim', released_at: null },
    { id: 'c', employee_id: 'e1', shift_date: '2026-09-12', starts_at: '2026-09-12T13:00', ends_at: '2026-09-12T21:00', status: 'worked', source: 'pattern', released_at: null },
    { id: 'd', employee_id: 'e1', shift_date: '2026-09-13', starts_at: '2026-09-13T13:00', ends_at: '2026-09-13T21:00', status: 'cancelled', source: 'pattern', released_at: null },
    { id: 'e', employee_id: null, shift_date: '2026-09-14', starts_at: '2026-09-14T13:00', ends_at: '2026-09-14T21:00', status: 'released', source: 'pattern', released_at: '2026-09-01T00:00' },
    { id: 'f', employee_id: 'e1', shift_date: '2026-09-15', starts_at: '2026-09-15T13:00', ends_at: '2026-09-15T21:00', status: 'missed', source: 'pattern', released_at: null },
  ];
  const out = build(rows);
  eq('only scheduled/claimed/worked rows are drawn', out.map((r) => r.id), ['a', 'b', 'c']);
  check('EVERY drawn row has origin instance — no synthesized rule rows', out.every((r) => r.origin === 'instance'));
  check('a CANCELLED day is not drawn as coverage', !out.some((r) => r.id === 'd'));
  check('a RELEASED day (no assignee) is not drawn as coverage', !out.some((r) => r.id === 'e'));
  check('a MISSED day is not drawn as coverage', !out.some((r) => r.id === 'f'));
  eq('every row is keyed to a real instance id', out.map((r) => r.id).filter((id) => rows.some((x) => x.id === id)).length, out.length);
}

console.log(`\n${passed} checks passed`);
