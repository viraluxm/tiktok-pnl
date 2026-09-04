// DELETE /api/admin/schedule/instances — the auth gate and the HTTP status mapping.
//
// Exercises the REAL route module, transpiled at runtime (the repo's .test.mjs pattern). Stubbed:
// `next/server` (NextResponse), the Supabase server client (identity), and adminShifts (so each
// ScheduleError code can be replayed without a database). The ScheduleError CLASS is shared
// between the stub and the route, so the route's `instanceof` check is exercised for real — a
// mismatch there would silently turn every 409 into a 500.
//
// Why this is worth a test: the gate is the whole authorization story for removal (there is no
// second RLS-level check on a service-role delete), and a refusal that maps to 500 instead of 409
// reaches the manager as "something went wrong" instead of the reason they need.
//
// Run:  TZ=UTC node src/app/api/admin/schedule/instances/route.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'instroute-'));
const write = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return pathToFileURL(p).href; };

// ── stubs ──
const nextStub = write('nextStub.mjs', `
export const NextResponse = {
  json: (body, init) => ({ body, status: (init && init.status) || 200 }),
};
`);
const releaseStub = write('releaseStub.mjs', `
export class ScheduleError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
`);
const supabaseStub = write('supabaseStub.mjs', `
export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: globalThis.__USER } }) } };
}
`);
const adminShiftsStub = write('adminShiftsStub.mjs', `
import { ScheduleError } from '${releaseStub}';
export async function postOneTimeShift() { return { id: 'x' }; }
export async function removeOneTimeShift(input) {
  globalThis.__CALLS.push(input);
  const t = globalThis.__THROW;
  if (t === undefined || t === null) return;
  if (t === 'PLAIN') throw new Error('kaboom');
  throw new ScheduleError(t, 'refused: ' + t);
}
`);

const srcPath = fileURLToPath(new URL('./route.ts', import.meta.url));
let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
for (const [from, to] of Object.entries({
  "'next/server'": `'${nextStub}'`,
  "'@/lib/supabase/server'": `'${supabaseStub}'`,
  "'@/lib/schedule/adminShifts'": `'${adminShiftsStub}'`,
  "'@/lib/schedule/release'": `'${releaseStub}'`,
})) outputText = outputText.split(from).join(to);
const { DELETE } = await import(write('route.mjs', outputText));

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const ADMIN = { id: 'owner-1', app_metadata: { role: 'admin' } };
const req = (body) => ({ json: async () => { if (body === '__BAD__') throw new Error('bad json'); return body; } });

async function call({ user = ADMIN, body = { id: 'inst-1' }, throws = null } = {}) {
  globalThis.__USER = user;
  globalThis.__THROW = throws;
  globalThis.__CALLS = [];
  const res = await DELETE(req(body));
  return { res, calls: globalThis.__CALLS };
}

console.log('\nauthorization — the gate is the same requireAdmin() POST uses');
{
  const { res, calls } = await call({ user: null }); // null, not undefined — a destructuring default would swap in ADMIN
  check('unauthenticated → 401', res.status === 401, `got ${res.status}`);
  check('  ↳ removal never invoked', calls.length === 0);
}
{
  const { res, calls } = await call({ user: { id: 'u2', app_metadata: { role: 'member' } } });
  check('non-admin (member) → 403', res.status === 403, `got ${res.status}`);
  check('  ↳ removal never invoked', calls.length === 0);
}
{
  const { res } = await call({ user: { id: 'u3', app_metadata: {} } });
  check('authenticated with no role → 403', res.status === 403, `got ${res.status}`);
}
{
  // The Postgres role is always 'authenticated'; the APP role lives in app_metadata. Reading the
  // wrong one is a documented footgun in this codebase, so assert the right one is decisive.
  const { res } = await call({ user: { id: 'u4', role: 'authenticated', app_metadata: { role: 'station' } } });
  check("top-level `role` is NOT accepted as the app role → 403", res.status === 403, `got ${res.status}`);
}

console.log('\nrequest validation');
{
  const { res } = await call({ body: '__BAD__' });
  check('unparseable body → 400', res.status === 400, `got ${res.status}`);
}
{
  const { res, calls } = await call({ body: {} });
  check('missing id → 400', res.status === 400, `got ${res.status}`);
  check('  ↳ removal never invoked', calls.length === 0);
}

console.log('\nsuccess');
{
  const { res, calls } = await call();
  check('eligible row → 200 { ok: true }', res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
  check('  ↳ userId comes from the SESSION, not the body', calls[0].userId === 'owner-1');
  check('  ↳ instanceId is forwarded', calls[0].instanceId === 'inst-1');
}
{
  // A caller-supplied user_id must not be able to widen scope.
  const { calls } = await call({ body: { id: 'inst-1', userId: 'someone-else' } });
  check('a body-supplied userId is ignored', calls[0].userId === 'owner-1');
}

console.log('\nstatus mapping — a refusal must reach the manager as a conflict, not a 500');
{
  const { res } = await call({ throws: 'NOT_FOUND' });
  check('NOT_FOUND → 404', res.status === 404, `got ${res.status}`);
}
for (const code of ['NOT_ONE_OFF', 'NOT_SCHEDULED', 'ALREADY_STARTED', 'WORKED_TIME_EXISTS', 'EMPLOYEE_CLOCKED_IN', 'SHIFT_UNAVAILABLE']) {
  const { res } = await call({ throws: code });
  check(`${code} → 409`, res.status === 409, `got ${res.status}`);
  check(`  ↳ body carries the code and a readable message`, res.body.code === code && res.body.error === `refused: ${code}`);
}
{
  const { res } = await call({ throws: 'READ_FAILED' });
  check('an internal ScheduleError (READ_FAILED) → 500', res.status === 500, `got ${res.status}`);
}
{
  const { res } = await call({ throws: 'REMOVE_FAILED' });
  check('REMOVE_FAILED → 500', res.status === 500, `got ${res.status}`);
}
{
  const { res } = await call({ throws: 'PLAIN' });
  check('a non-ScheduleError throw → 500', res.status === 500, `got ${res.status}`);
}

console.log(`\nALL PASSED (${passed} assertions)\n`);
