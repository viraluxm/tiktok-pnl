// useScheduleBulk: the shared client mutation — its HTTP contract and, above all, its CACHE
// INVALIDATION. Every schedule surface (roster summary, builder weeks, month calendar) reads the
// ['shift_instances', …] prefix, so a save that failed to invalidate it would leave stale weeks on
// screen until a manual refresh — the exact bug Part 10 forbids.
//
// Exercises the REAL hook module, transpiled at runtime. `@tanstack/react-query` is stubbed to
// capture the mutation options and record invalidations (no React needed — the hook body is plain
// function calls once the two hooks are stubbed). `fetch` is stubbed per case.
//
// Run:  TZ=UTC node src/hooks/useScheduleBulk.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'usebulk-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
const rqStub = write('rq.mjs', `
export function useMutation(opts) { globalThis.__MUT = opts; return { opts }; }
export function useQueryClient() { return { invalidateQueries: (arg) => globalThis.__INV.push(arg) }; }
`);
const srcPath = fileURLToPath(new URL('./useScheduleBulk.ts', import.meta.url));
let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
outputText = outputText.split("'@tanstack/react-query'").join(`'${rqStub}'`).replace(/^'use client';\s*/m, '');
const H = await import(write('useScheduleBulk.mjs', outputText));

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

console.log('\ninvalidation');
{
  globalThis.__INV = [];
  // Not a component: react-query's two hooks are stubbed above, so calling the hook here is a plain
  // function call that returns the mutation options we want to inspect.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { apply } = H.useScheduleBulk();
  eq('mutation fn is the bulk poster', apply.opts.mutationFn, H.postScheduleBulk);
  apply.opts.onSuccess({ ok: true }, { entries: [] });
  eq('a real save invalidates the shift_instances PREFIX (every cached range)', globalThis.__INV, [{ queryKey: ['shift_instances'] }]);
  globalThis.__INV = [];
  apply.opts.onSuccess({ ok: true, dryRun: true }, { entries: [], dryRun: true });
  eq('a dry run invalidates nothing (it wrote nothing)', globalThis.__INV, []);
  eq('the prefix constant matches what useShiftInstances keys on', [...H.SHIFT_INSTANCES_QUERY_PREFIX], ['shift_instances']);
}

console.log('\nHTTP contract');
const fetchWith = (status, body) => { globalThis.__REQ = null; globalThis.fetch = async (url, init) => { globalThis.__REQ = { url, init }; return { ok: status < 400, status, json: async () => body }; }; };
{
  fetchWith(200, { ok: true, dryRun: false, created: 2, updated: 0, removed: 1, unchanged: 0 });
  const entries = [{ employeeId: 'e', date: '2026-09-10', startTime: '06:00', endTime: '14:00' }];
  const r = await H.postScheduleBulk({ entries });
  eq('POSTs to the bulk route', [globalThis.__REQ.url, globalThis.__REQ.init.method], ['/api/admin/schedule/instances/bulk', 'POST']);
  eq('body carries entries and an explicit boolean dryRun', JSON.parse(globalThis.__REQ.init.body), { entries, dryRun: false });
  eq('returns the counts', [r.created, r.removed], [2, 1]);
  fetchWith(200, { ok: true, dryRun: true, created: 1, updated: 0, removed: 0, unchanged: 0 });
  await H.postScheduleBulk({ entries, dryRun: true });
  eq('dryRun:true is sent', JSON.parse(globalThis.__REQ.init.body).dryRun, true);
}
{
  const refusals = [
    { employeeId: 'e', date: '2026-09-10', code: 'PAST_DATE', message: 'Past days cannot be scheduled.' },
    { employeeId: 'e', date: '2026-09-11', code: 'BAD_TIMES', message: 'Start and end cannot be the same time.' },
  ];
  fetchWith(409, { error: 'Some days could not be saved.', refusals });
  await assert.rejects(H.postScheduleBulk({ entries: [] }), (e) => e instanceof H.ScheduleRefusedError && e.refusals.length === 2);
  check('409 → ScheduleRefusedError carrying every refusal', true);
  eq('message leads with the first day and counts the rest', H.summariseRefusals(refusals), '2026-09-10: Past days cannot be scheduled. (+1 more)');
  eq('single refusal has no "+more"', H.summariseRefusals([refusals[0]]), '2026-09-10: Past days cannot be scheduled.');
  fetchWith(500, { error: 'Could not save the schedule.' });
  await assert.rejects(H.postScheduleBulk({ entries: [] }), /Could not save the schedule/);
  check('500 → plain Error with the server message', true);
  fetchWith(403, {});
  await assert.rejects(H.postScheduleBulk({ entries: [] }), /Could not save the schedule/);
  check('non-JSON/empty error body → fallback message, never a crash', true);
}

console.log(`\n${passed} checks passed`);
