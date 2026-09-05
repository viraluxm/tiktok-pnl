// POST /api/admin/schedule/instances/bulk — the auth gate and the HTTP status mapping.
//
// Exercises the REAL route module, transpiled at runtime (the repo's .test.mjs pattern). Stubbed:
// `next/server`, the Supabase server client (who is logged in), and bulkSchedule (so each outcome
// can be replayed without a database). schedulePlan's parseScheduleEntries is REAL — the 400 path
// is the real validator. The ScheduleBatchError CLASS is shared between the stub and the route so
// the `instanceof` branch is exercised for real.
//
// Why: the gate is the whole authorization story for this write (service-role beneath it), and a
// refusal that maps to 500 instead of 409 reaches the manager as "something went wrong" instead of
// the day and reason they need to fix.
//
// Run:  TZ=UTC node src/app/api/admin/schedule/instances/bulk/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'bulkroute-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };
function transpile(srcRel, outName, rewrites = {}) {
  const srcPath = fileURLToPath(new URL(srcRel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [from, to] of Object.entries(rewrites)) outputText = outputText.split(from).join(to);
  return write(outName, outputText);
}

const nextStub = write('nextStub.mjs', `
export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };
`);
const supabaseStub = write('supabaseStub.mjs', `
export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } };
}
`);
const bulkStub = write('bulkStub.mjs', `
export class ScheduleBatchError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
export async function applyScheduleBatch(input) {
  globalThis.__CALLS.push(input);
  const r = globalThis.__REPLY;
  if (r instanceof Error) throw r;
  return r;
}
`);
const timezone = transpile('../../../../../../lib/schedule/timezone.ts', 'timezone.mjs');
const weekly = transpile('../../../../../../lib/weeklySchedule.ts', 'weeklySchedule.mjs');
const eligibility = transpile('../../../../../../lib/schedule/eligibility.ts', 'eligibility.mjs');
const plan = transpile('../../../../../../lib/schedule/schedulePlan.ts', 'schedulePlan.mjs', {
  "'./timezone'": `'${timezone}'`, "'@/lib/weeklySchedule'": `'${weekly}'`, "'./eligibility'": `'${eligibility}'`,
});
const routeUrl = transpile('./route.ts', 'route.mjs', {
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${supabaseStub}'`,
  "'@/lib/schedule/bulkSchedule'": `'${bulkStub}'`,
  "'@/lib/schedule/schedulePlan'": `'${plan}'`,
});
const { POST } = await import(routeUrl);
const { ScheduleBatchError } = await import(bulkStub);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const ADMIN = { id: 'owner-1', app_metadata: { role: 'admin' } };
const req = (body) => ({ json: async () => { if (body === 'MALFORMED') throw new Error('bad json'); return body; } });
const GOOD = { entries: [{ employeeId: 'e1', date: '2026-09-10', startTime: '06:00', endTime: '14:00' }] };
const OK_REPLY = { ok: true, dryRun: false, counts: { created: 1, updated: 0, removed: 0, unchanged: 0 } };
const setup = (user, reply = OK_REPLY) => { globalThis.__USER = user; globalThis.__REPLY = reply; globalThis.__CALLS = []; };

console.log('\nauth gate');
{
  setup(null);
  const r = await POST(req(GOOD));
  eq('no session → 401, nothing called', [r.status, globalThis.__CALLS.length], [401, 0]);
  setup({ id: 'u', app_metadata: { role: 'timeclock' } });
  eq('confined kiosk role → 403', (await POST(req(GOOD))).status, 403);
  setup({ id: 'u', app_metadata: { role: 'member' } });
  eq('member → 403', (await POST(req(GOOD))).status, 403);
  setup({ id: 'u', app_metadata: {} });
  eq('owner WITHOUT admin role → 403 (same contract as the sibling routes)', (await POST(req(GOOD))).status, 403);
  check('no write path was reached by any denied caller', globalThis.__CALLS.length === 0);
}

console.log('\nbad requests → 400, never reach the write path');
{
  setup(ADMIN);
  eq('malformed JSON', (await POST(req('MALFORMED'))).status, 400);
  eq('missing entries', (await POST(req({}))).status, 400);
  eq('empty entries', (await POST(req({ entries: [] }))).status, 400);
  const r = await POST(req({ entries: [{ employeeId: 'e1', date: '2026-13-40', startTime: '06:00', endTime: '14:00' }] }));
  eq('invalid date → 400 with the validator message', [r.status, r.body.error], [400, 'entries[0].date must be YYYY-MM-DD']);
  eq('bad time', (await POST(req({ entries: [{ employeeId: 'e1', date: '2026-09-10', startTime: '6:00', endTime: '14:00' }] }))).status, 400);
  eq('too many', (await POST(req({ entries: Array.from({ length: 501 }, () => ({ employeeId: 'e', date: '2026-09-10', off: true })) }))).status, 400);
  check('none of those reached applyScheduleBatch', globalThis.__CALLS.length === 0);
}

console.log('\nhappy path');
{
  setup(ADMIN);
  const r = await POST(req(GOOD));
  eq('200 with flattened counts', [r.status, r.body], [200, { ok: true, dryRun: false, created: 1, updated: 0, removed: 0, unchanged: 0 }]);
  const call = globalThis.__CALLS[0];
  eq('userId comes from the SESSION, entries are the parsed ones, dryRun false by default', [call.userId, call.entries, call.dryRun], [ADMIN.id, GOOD.entries, false]);
  setup(ADMIN, { ...OK_REPLY, dryRun: true });
  const d = await POST(req({ ...GOOD, dryRun: true }));
  eq('dryRun:true is passed through and echoed', [globalThis.__CALLS[0].dryRun, d.body.dryRun], [true, true]);
  setup(ADMIN);
  await POST(req({ ...GOOD, dryRun: 'yes' }));
  eq('dryRun must be the boolean true — a truthy string does NOT dry-run', globalThis.__CALLS[0].dryRun, false);
}

console.log('\nrefusals → 409 with every refusal, and a manager-readable error');
{
  const refusals = [{ employeeId: 'e1', date: '2026-09-10', code: 'WORKED_TIME_EXISTS', message: 'This employee already has worked time on that date.' }];
  setup(ADMIN, { ok: false, refusals });
  const r = await POST(req(GOOD));
  eq('409 + refusals verbatim', [r.status, r.body.refusals], [409, refusals]);
  check('top-level error is a sentence', typeof r.body.error === 'string' && r.body.error.length > 0);
}

console.log('\nfailures → 500, with the code but not the raw DB message');
{
  setup(ADMIN, new ScheduleBatchError('WRITE_FAILED', 'duplicate key value violates …'));
  const r = await POST(req(GOOD));
  eq('ScheduleBatchError → 500 with code', [r.status, r.body.code], [500, 'WRITE_FAILED']);
  check('raw DB text is not leaked to the client', !JSON.stringify(r.body).includes('duplicate key'));
  setup(ADMIN, new Error('kaboom'));
  const p = await POST(req(GOOD));
  eq('plain Error → 500 without a code', [p.status, p.body.code], [500, undefined]);
}

console.log(`\n${passed} checks passed`);
