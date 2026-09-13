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
  // request-shift is included deliberately: a capacity request is a WRITE on the public token
  // surface, so it must satisfy the same four invariants as every other one.
  const routes = [...routeFiles(here), ...routeFiles(join(here, '..', 'trade')), ...routeFiles(join(here, '..', 'request-shift'))];
  check('found the portal + trade + request-shift routes', routes.length >= 8, `${routes.length}`);
  check('request-shift is among them', routes.some((p) => p.includes('request-shift')));
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
  for (const f of ['portalSnapshot.ts', 'timecard.ts', 'trade.ts', 'capacityBoard.ts']) {
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

  // CAPACITY (156). The team boundary is a QUERY PREDICATE, so another team's blocks, capacities
  // and staffing counts never reach the browser to be hidden there.
  const cb = strip(read(join(lib, 'capacityBoard.ts')));
  check('capacityBoard: the team derives from the TOKEN employee\'s role', /payrollTeamOfRole\(employee\.role\)/.test(cb));
  check('capacityBoard: blocks are filtered to that team server-side', /blockQ\.eq\('team', team\)/.test(cb));
  check('capacityBoard: settings are filtered to that team server-side', /settingQ\.eq\('team', team\)/.test(cb));
  check('capacityBoard: an unrecognised role gets NO board at all', /if \(!team\) return \[\];/.test(cb));
  // CAPACITY IS EXPLICIT. An unconfigured block publishes nothing — not a disabled row, nothing.
  check('capacityBoard: an unconfigured block publishes no opportunity', /if \(!s\.configured\) continue;/.test(cb));
  // …and that filter lives in the CAPACITY loop only, so a coworker's offered shift is untouched
  // by whether anyone has configured a number. Offers come from getAvailableShifts, which knows
  // nothing about capacity, and the snapshot concatenates the two lists.
  const snapSrc = strip(read(join(lib, 'portalSnapshot.ts')));
  check('portalSnapshot: offers and capacity are separate sources',
    /getAvailableShifts\(employee, now\)/.test(snapSrc) && /getCapacityAvailability\(employee, now\)/.test(snapSrc));
  check('portalSnapshot: the offer list is never filtered by capacity',
    !/kind: 'offer'[\s\S]{0,400}?configured/.test(snapSrc));
  const capSrc = strip(read(join(lib, 'capacity.ts')));
  check('capacity: the resolution chain ends in null, not a constant',
    /capacity: local \?\? t\?\.capacity \?\? null/.test(capSrc));
  check('capacity: the suggested number is never read during resolution',
    !/resolveCapacity[\s\S]{0,600}?SUGGESTED_TEAM_CAPACITY/.test(capSrc));
  check('capacityBoard: the request insert takes employee_id from the token employee, never the body',
    /employee_id: employee\.id/.test(cb) && !/employee_id: (body|input)\./.test(cb));
  check('capacityBoard: the request insert takes the owner from the token employee', /user_id: owner/.test(cb));
  check('capacityBoard: the team written on a request is derived, never accepted', /const team = capacityTeamOf\(employee\)/.test(cb));
  check('capacityBoard: the span is recomputed from the block, never accepted from the client',
    /starts_at: opp\.starts_at/.test(cb) && /ends_at: opp\.ends_at/.test(cb));
  check('capacityBoard: withdraw is scoped to the token employee AND the owner',
    /\.eq\('user_id', owner\)[\s\S]{0,120}?\.eq\('employee_id', employee\.id\)/.test(cb));
  check('capacityBoard: a pending request survives its block being paused, so it stays withdrawable',
    /ORPHANED REQUESTS/.test(read(join(lib, 'capacityBoard.ts'))) && /for \(const r of myRequestRows\)/.test(cb));
  // The Requests tab reads MY requests and nobody else's, and carries no capacity configuration.
  check('capacityBoard: the Requests read is scoped to the token employee AND the owner',
    /from\('shift_requests'\)[\s\S]{0,400}?\.eq\('user_id', owner\)[\s\S]{0,200}?\.eq\('employee_id', employee\.id\)/.test(cb));
  check('capacityBoard: the Requests read selects no capacity, block config or manager note',
    !/from\('shift_requests'\)\s*\.select\([^)]*(capacity|closed|decision_note)/.test(cb));
  check('portalTypes: a shift request exposes no capacity configuration',
    !/capacity|staffed|setup/.test(strip(read(join(lib, 'portalTypes.ts'))).match(/interface ShiftRequestView \{[^}]*\}/)?.[0] ?? ''));
  check('capacityBoard: never writes shift_instances — only an approval may',
    !/from\('shift_instances'\)[\s\S]{0,160}?\.(update|insert|delete)\(/.test(cb));

  // THE STAFFED COUNT MUST NOT EXCLUDE OFFERED SHIFTS. Carlos still owns a shift he dropped, so
  // excluding it would advertise an 11th spot on a 10-setup floor.
  const cap = strip(read(join(lib, 'capacity.ts')));
  check('capacity: the staffed count has no offer_state clause', !/offer_state/.test(cap));
  check('capacity: only scheduled/claimed count as staffed', /STAFFING_STATUSES = new Set\(\['scheduled', 'claimed'\]\)/.test(cap));
  check('capacity: availability is clamped at zero', /Math\.max\(0, capacity - staffed\)/.test(cap));

  // MANAGER WRITES. The owner is the session uid; nothing is taken from the body.
  const ca = strip(read(join(lib, 'capacityAdmin.ts')));
  for (const [, table, chain] of ca.matchAll(/\.from\('([a-z_]+)'\)([\s\S]*?);/g)) {
    const scoped = /\.eq\('user_id', (input\.)?ownerId\)/.test(chain) || /user_id: (input\.)?ownerId/.test(chain);
    check(`capacityAdmin: ${table} statement carries an explicit owner filter`, scoped);
  }
  check('capacityAdmin: approval goes ONLY through the atomic RPC',
    /rpc\('lensed_approve_shift_request'/.test(ca) && !/from\('shift_instances'\)/.test(ca));

  // ── THE WRITE GUARD (157). Every manager write path that can ADD staffing goes through a
  //    locked, recounting SQL function; the fallback is narrow and only fires when it is absent.
  const bs = strip(read(join(lib, 'bulkSchedule.ts')));
  check('bulkSchedule: the write goes through the locked batch function',
    /rpc\('lensed_apply_schedule_batch'/.test(bs));
  check('bulkSchedule: the unguarded sequence runs ONLY when the function is missing',
    /if \(!isMissingFunction\(guarded\.error\)\) throw/.test(bs));
  check('bulkSchedule: capacity refusals are per-row, not a whole-batch failure',
    /refusals/.test(bs) && /ok: true[\s\S]{0,400}?refusals/.test(bs));
  const as2 = strip(read(join(lib, 'adminShifts.ts')));
  check('adminShifts: an ASSIGNED one-time shift goes through the same batch function',
    /if \(input\.employeeId\)[\s\S]{0,400}?rpc\('lensed_apply_schedule_batch'/.test(as2));
  const cg = strip(read(join(lib, 'capacityGuard.ts')));
  check('capacityGuard: the legacy board assignment goes through the locked function',
    /rpc\('lensed_assign_released_shift'/.test(cg));
  check('capacityGuard: the missing-function test is narrow (a real error must surface)',
    /PGRST202/.test(cg) && /42883/.test(cg) && /if \(!isMissingFunction\(guarded\.error\)\) return/.test(cg));
  const cl = strip(read(join(lib, 'claim.ts')));
  check('claim: the auto-approve flip no longer writes shift_instances directly',
    /assignReleasedShift\(/.test(cl) && !/from\('shift_instances'\)[\s\S]{0,200}?\.update\(\{ status: 'claimed'/.test(cl));
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
