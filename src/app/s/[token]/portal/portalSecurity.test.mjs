// SECURITY INVARIANTS of the employee portal, asserted over the real source (comments stripped).
//
// The threat model: /s/[token] is public and service-role. The ONLY thing that may decide whose
// data a request touches is the token. So:
//   1. every portal/trade route resolves the employee through the shared guard and never reads an
//      employee, owner or tenant id from the request;
//   2. every server builder scopes every table read by the token-resolved owner;
//   3. no employee-facing read selects `*` from employees or names a private column.
// A route-level test with a fake DB cannot prove "no code path forgot the owner filter"; a grep
// over the shipped source can, which is why this file exists alongside the kernel tests.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (p) => readFileSync(p, 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };

function routeFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}

console.log('\n1. ROUTES — identity comes from the token, never from the request');
{
  const routes = [...routeFiles(here), ...routeFiles(join(here, '..', 'trade'))];
  check('found the portal + trade routes', routes.length >= 7, `${routes.length}`);
  for (const p of routes) {
    const src = strip(read(p));
    const name = p.split('/s/[token]/')[1];
    check(`${name}: uses guardPublicRead or guardPublicWrite`, /guardPublic(Read|Write)\(token, req\)/.test(src));
    check(`${name}: employee is taken from the guard's resolved token`, /guard\.resolved/.test(src));
    check(`${name}: never reads an employee/owner/user id from the body or query`,
      !/body\.(employee_?[iI]d|owner|user_?[iI]d|tenant)/.test(src) && !/searchParams\.get\(['"](employee|owner|user|tenant)/.test(src));
    check(`${name}: no direct DB access — goes through the lib`, !/createAdminClient|from\('/.test(src));
  }
}

console.log('\n2. SERVER BUILDERS — every table read is owner-scoped');
{
  const lib = join(here, '..', '..', '..', '..', 'lib', 'schedule');
  for (const f of ['portalSnapshot.ts', 'timecard.ts', 'trade.ts']) {
    const src = strip(read(join(lib, f)));
    // Split into individual query chains: from('table') ... up to the next statement end.
    const chains = [...src.matchAll(/\.from\('([a-z_]+)'\)([\s\S]*?);/g)];
    check(`${f}: has query chains to inspect`, chains.length > 0, `${chains.length}`);
    for (const [, table, chain] of chains) {
      const scoped = /\.eq\('user_id',/.test(chain) || /\.in\('user_id',/.test(chain) || /user_id:/.test(chain);
      check(`${f}: ${table} read carries an explicit user_id (owner) filter`, scoped);
    }
    check(`${f}: never select('*') on employees`, !/from\('employees'\)\s*\.select\('\*'\)/.test(src));
    check(`${f}: never selects hourly_rate / phone / pin / photo`, !/select\([^)]*(hourly_rate|phone|pin_hash|override_pin|photo_path)/.test(src));
  }
  // The snapshot's own-data reads must ALSO be filtered by the token's employee id.
  const snap = strip(read(join(lib, 'portalSnapshot.ts')));
  for (const table of ['shift_claims', 'time_off_requests']) {
    const chain = snap.match(new RegExp(`\\.from\\('${table}'\\)([\\s\\S]*?);`))?.[1] ?? '';
    check(`portalSnapshot: ${table} is filtered to the token's employee`, /\.eq\('(claimed_by|employee_id)', employee\.id\)/.test(chain));
  }
  const tc = strip(read(join(lib, 'timecard.ts')));
  check('timecard: shifts read is filtered to the token\'s employee', /from\('shifts'\)[\s\S]*?\.eq\('employee_id', employee\.id\)/.test(tc));
  check('timecard: employee_time_entries read is filtered to the token\'s employee', /from\('employee_time_entries'\)[\s\S]*?\.eq\('employee_id', employee\.id\)/.test(tc));
  // TEAM BOUNDARY (Team schedule). The viewer's team comes from the token-resolved employee, the
  // instance read asks ONLY for same-team roster ids, and the row's own role is re-checked.
  const ts = strip(read(join(lib, 'teamSchedule.ts')));
  check('teamSchedule: team derives from the TOKEN employee\'s role', /const team = teamOfRole\(employee\.role\)/.test(ts));
  check('teamSchedule: roster read is owner-scoped', /from\('employees'\)[\s\S]*?\.eq\('user_id', employee\.user_id\)/.test(ts));
  check('teamSchedule: instances are requested only for same-team ids', /from\('shift_instances'\)[\s\S]*?\.in\('employee_id', teamIds\)/.test(ts));
  check('teamSchedule: a row whose own role names another team is dropped', /teamOfRole\(role\) !== team\) continue/.test(ts));
  check('teamSchedule: never selects private employee columns', !/select\([^)]*(hourly_rate|phone|pin_hash|override_pin|photo_path)/.test(ts));
  const tr = strip(read(join(lib, 'trade.ts')));
  check('trade: the requester is always employee.id (never a parameter)', /requester_employee_id: employee\.id/.test(tr) && !/requester_employee_id: (body|input|req)\./.test(tr));
  check('trade: the target employee is derived from who OWNS the target shift', /readParty\(admin, owner, theirs\.employee_id\)/.test(tr));
  check('trade: coworker response CAS re-asserts target_employee_id = employee.id', /\.eq\('target_employee_id', employee\.id\)[\s\S]*?\.eq\('status', 'pending_coworker'\)/.test(tr));
  check('trade: cancel CAS re-asserts requester_employee_id = employee.id', /\.eq\('requester_employee_id', employee\.id\)[\s\S]*?\.in\('status', LIVE\)/.test(tr));
  check('trade: approval goes ONLY through the atomic RPC', /rpc\('lensed_approve_shift_trade'/.test(tr) && !/from\('shift_instances'\)\s*\.update/.test(tr));
  check('trade: no direct write to shift_instances anywhere in the module', !/from\('shift_instances'\)[\s\S]{0,120}?\.(update|insert|delete)\(/.test(tr));
}

console.log('\n3. WIRE TYPES — nothing private can be typed onto the client payload');
{
  const types = strip(read(join(here, '..', '..', '..', '..', 'lib', 'schedule', 'portalTypes.ts')));
  check('portalTypes never mentions hourly_rate / phone / pin / notes / payroll', !/hourly_rate|phone|pin_hash|override_pin|photo_path|decision_note_private|payroll/.test(types));
  const teamShift = types.match(/interface PortalTeamShift \{[^}]*\}/)?.[0] ?? '';
  check('PortalTeamShift is present', teamShift.length > 0);
  check('coworker rows carry no employee_id', !/employee_id/.test(teamShift));
  check("portalTypes has no value imports and no 'server-only'", !/^import (?!type)/m.test(types) && !/server-only/.test(types));
}

console.log(`\n${passed} checks passed`);
