// THE PARTIAL-SAVE RESULT, as the manager is told about it.
//
// lensed_apply_schedule_batch (157) deliberately lets the rows that fit succeed and refuses only
// the additions that would exceed capacity. That is the right behaviour and the wrong thing to be
// quiet about: after a partial save, part of the week IS on the schedule and part is not, so a
// bare success toast and a bare failure toast are both lies.
//
// This file pins the sentence, and the boundary between the two refusal kinds:
//   PLANNER refusal   → HTTP 409, ScheduleRefusedError, NOTHING was written
//   CAPACITY refusal  → HTTP 200, result.refusals, the other rows WERE written
//
// Run:  TZ=UTC node src/hooks/scheduleBulkResult.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'bulkresult-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const reactQueryStub = write('rq.mjs', 'export const useMutation = () => ({});\nexport const useQueryClient = () => ({});\n');
const tz = transpile('../lib/schedule/timezone.ts', 'timezone.mjs');
const format = transpile('../lib/schedule/format.ts', 'format.mjs', { "'./timezone'": `'${tz}'` });
const H = await import(transpile('./useScheduleBulk.ts', 'useScheduleBulk.mjs', {
  "'@tanstack/react-query'": `'${reactQueryStub}'`,
  "'@/lib/schedule/format'": `'${format}'`,
}));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const refusal = (o = {}) => ({
  employeeId: 'emp-carlos', date: '2026-09-16', code: 'OVER_CAPACITY',
  message: 'That block is fully staffed for this day. Raise the capacity or free a shift first.', ...o,
});
const NAMES = { 'emp-carlos': 'Carlos Ruiz', 'emp-juan': 'Juan Perez' };
const nameOf = (id) => NAMES[id];

console.log('\nPARTIAL SAVE — what the manager is told');

// A clean save says nothing extra. Silence here is correct: everything asked for happened.
eq('a save with no refusals produces no message',
  H.summarisePartialSave({ created: 5, updated: 0, refusals: [] }, nameOf), null);
eq('…and an undefined refusal list is treated the same',
  H.summarisePartialSave({ created: 5, updated: 0 }, nameOf), null);

// THE CORE CASE. Both halves of the truth, in one sentence.
{
  const msg = H.summarisePartialSave({ created: 3, updated: 0, refusals: [refusal()] }, nameOf);
  check('the message leads with what WAS scheduled', msg.startsWith('3 shifts scheduled.'), msg);
  check('…then says how many were not', msg.includes('1 shift could not be scheduled'), msg);
  check('…names WHO, so the manager can find the row', msg.includes('Carlos Ruiz'), msg);
  check('…names WHICH DAY', msg.includes('Sep 16'), msg);
  check('…and why', /fully staffed/.test(msg), msg);
  check('…with no em dash', !msg.includes('—'), msg);
}

// Updates count as scheduled too: re-timing a day is a row that landed.
{
  const msg = H.summarisePartialSave({ created: 1, updated: 2, refusals: [refusal()] }, nameOf);
  check('created and updated are both "scheduled"', msg.startsWith('3 shifts scheduled.'), msg);
}

// Several casualties: name the first, count the rest. A list nobody reads is not information.
{
  const msg = H.summarisePartialSave(
    { created: 2, updated: 0, refusals: [refusal(), refusal({ employeeId: 'emp-juan', date: '2026-09-17' }), refusal({ date: '2026-09-18' })] },
    nameOf,
  );
  check('the count is the total refused', msg.includes('3 shifts could not be scheduled'), msg);
  check('the first is named in full', msg.includes('Carlos Ruiz') && msg.includes('Sep 16'), msg);
  check('the rest are counted, not listed', msg.includes('plus 2 more.'), msg);
}

// EVERY row refused. There is no "3 shifts scheduled" to lead with, and claiming one would be the
// exact failure this function exists to prevent.
{
  const msg = H.summarisePartialSave({ created: 0, updated: 0, refusals: [refusal()] }, nameOf);
  check('a fully refused save never claims anything was scheduled', !/scheduled\./.test(msg.split(':')[0]), msg);
  check('…and still says what happened', msg.startsWith('1 shift could not be scheduled'), msg);
}

// Without a name lookup the day still has to be there: it is the minimum to find the row again.
{
  const msg = H.summarisePartialSave({ created: 1, updated: 0, refusals: [refusal()] });
  check('no name lookup still names the day', msg.includes('Sep 16'), msg);
  check('…and does not print "undefined"', !msg.includes('undefined'), msg);
}

console.log('\nTHE TWO REFUSAL KINDS ARE DIFFERENT THINGS');
{
  // A PLANNER refusal means nothing was written; it must never be reported as a partial save.
  check('ScheduleRefusedError exists for the nothing-was-written case', typeof H.ScheduleRefusedError === 'function');
  const err = new H.ScheduleRefusedError([refusal({ code: 'PAST_DATE', message: 'Past days cannot be scheduled.' })]);
  check('…and carries the refusals', err.refusals.length === 1);
  check('…with its own summary, which never claims a partial success',
    !/scheduled\./.test(err.message.split(':')[0]) && !err.message.includes('could not be scheduled'), err.message);
}

// THE SOURCE-LEVEL GUARANTEES. A capacity refusal arrives on a SUCCESSFUL rpc call, so there is no
// error to fall back on — the unguarded path is unreachable from here by construction. Asserted
// over the shipped source because no unit fixture can prove "this branch cannot be entered".
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const bulk = strip(readFileSync(fileURLToPath(new URL('../lib/schedule/bulkSchedule.ts', import.meta.url)), 'utf8'));
  check('the fallback is reached ONLY when the function is missing',
    /if \(!isMissingFunction\(guarded\.error\)\) throw new ScheduleBatchError/.test(bulk));
  check('the guarded branch returns before any unguarded write can run',
    bulk.indexOf('applyScheduleBatchUnguarded') > bulk.indexOf('if (!guarded.error)'));
  // The real property, not textual proximity: the guarded branch RETURNS, so a capacity refusal
  // cannot fall through to the unguarded write no matter what it contains.
  const guardedBlock = bulk.slice(bulk.indexOf('if (!guarded.error)'), bulk.indexOf('if (!isMissingFunction(guarded.error))'));
  check('the guarded branch returns, so a capacity refusal cannot fall through',
    /return \{[\s\S]*?refusals,\s*\};/.test(guardedBlock));
  check('…and the guarded branch contains no call to the unguarded path',
    !guardedBlock.includes('applyScheduleBatchUnguarded'));
  check('no default capacity is handed to SQL at all', !bulk.includes('p_default_capacity'));

  // And the two consumers must both report it rather than showing a bare success.
  const builder = strip(readFileSync(fileURLToPath(new URL('../components/employees/schedule/EmployeeScheduleBuilder.tsx', import.meta.url)), 'utf8'));
  check('the builder reports a partial save instead of its success step',
    /summarisePartialSave\(result[\s\S]{0,80}?if \(partial\) \{ setError\(partial\); return; \}/.test(builder));
  const cal = strip(readFileSync(fileURLToPath(new URL('../components/employees/weekly/ScheduleMonthCalendar.tsx', import.meta.url)), 'utf8'));
  check('the crew modal surfaces it too, with employee names',
    /summarisePartialSave\(result, \(id\) => employees\.find/.test(cal) && /if \(partial\) throw new Error\(partial\)/.test(cal));
}

console.log(`\n${passed} checks passed`);
