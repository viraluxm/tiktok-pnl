// BLOCKER C — the employee-facing Team Schedule must be REAL shift_instances only.
//
// Two surfaces existed. This file pins what each one is now, and — more importantly — pins the
// AUDIT FINDING that stopped the originally-preferred fix, so nobody re-attempts it later:
//
//   /s/[token]        → employee_access_tokens → resolves an EMPLOYEE  (the Phase 2 portal)
//   /s/team/[token]   → team_schedule_tokens   → resolves an OWNER     (a manager-shared board)
//
// Those are DISJOINT token namespaces. Redirecting /s/team/[token] to /s/[token]?view=team "using
// the same token" is impossible: a team token does not identify an employee, so the target would
// 404 and the live shared link would break. The board is therefore kept and made instance-only
// instead, which achieves the actual goal (zero recurring synthesis on employee-reachable paths)
// without destroying a distinct, in-use feature.
//
// Run:  TZ=UTC node src/lib/schedule/teamScheduleCleanup.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// Strip comments before asserting: these files EXPLAIN the removal at length, and matching the
// explanation instead of the code would make every guard here permanently, silently green.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\n1. THE TWO TOKEN NAMESPACES ARE DISJOINT (why a redirect is impossible)');
{
  const empTok = code('./tokens.ts');
  const teamTok = code('./teamScheduleToken.ts');
  check('the employee portal resolves employee_access_tokens', /from\('employee_access_tokens'\)/.test(empTok));
  check('the team board resolves team_schedule_tokens', /from\('team_schedule_tokens'\)/.test(teamTok));
  check('the team board reads only a user_id (an OWNER, not an employee)',
    /\.select\('user_id'\)/.test(teamTok) && !/employee_id/.test(teamTok));
  check('so a team token can never identify an employee — redirect ruled out', true);
}

console.log('\n2. /s/team/[token] IS NOW INSTANCE-ONLY');
{
  const src = code('../../app/s/team/[token]/page.tsx');
  check('no generateRecurringShifts call', !src.includes('generateRecurringShifts('));
  check('no shift_rules read', !src.includes("from('shift_rules')"));
  check('no shift_exceptions read', !src.includes("from('shift_exceptions')"));
  check('still reads real shift_instances', src.includes("from('shift_instances')"));
  check('still owner-scoped by the resolved token', /\.eq\('user_id', ownerId\)/.test(src));
  // Statuses stay filtered to real coverage, and released rows stay hidden.
  check('filters to scheduled/claimed/worked only', /'scheduled'[\s\S]{0,60}'claimed'[\s\S]{0,60}'worked'/.test(src));
  check('skips released rows', /released_at\)\s*continue|i\.released_at\) continue/.test(src));
  // PAYROLL / PII: a forwardable link must never carry pay.
  check('employees read is name/role only — no rate, no phone',
    /\.select\('id, name, role, status'\)/.test(src));
  check('no hourly_rate anywhere', !/hourly_rate/.test(src));
  check('no phone anywhere', !/phone/.test(src));
  check('never reads the payroll `shifts` table', !src.includes("from('shifts')"));
}

console.log('\n3. NO EMPLOYEE-REACHABLE PATH SYNTHESIZES A RECURRING SCHEDULE');
{
  const sDir = fileURLToPath(new URL('../../app/s', import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const files = walk(sDir).filter((f) => /\.(ts|tsx)$/.test(f));
  check('there are files under src/app/s to check', files.length > 0, `${files.length} files`);

  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const offenders = files.filter((f) => strip(readFileSync(f, 'utf8')).includes('generateRecurringShifts('));
  check('ZERO of them call generateRecurringShifts', offenders.length === 0,
    offenders.map((f) => f.split('/app/')[1]).join(',') || 'none');

  const ruleReaders = files.filter((f) => strip(readFileSync(f, 'utf8')).includes("from('shift_rules')"));
  check('ZERO of them read shift_rules', ruleReaders.length === 0,
    ruleReaders.map((f) => f.split('/app/')[1]).join(',') || 'none');
}

console.log('\n4. /api/member/team/shifts — dead recurring payload removed, caller intact');
{
  const route = code('../../app/api/member/team/shifts/route.ts');
  const caller = code('../../app/(station)/team/staff/page.tsx');

  // AUDIT: the route is NOT dead — (station)/team/staff still calls it. But it used to also return
  // every active shift_rule, and the caller never read that key. Fetched, serialised, discarded.
  check('the route is still called by (station)/team/staff', caller.includes('/api/member/team/shifts'));
  check('the caller consumes shift_instances', caller.includes('shift_instances'));
  check('the caller consumes shifts', caller.includes('sh.shifts'));
  check('the caller NEVER referenced shift_rules', !caller.includes('shift_rules'));

  check('the route no longer queries shift_rules', !route.includes("from('shift_rules')"));
  check('the route no longer returns a shift_rules key', !/shift_rules:/.test(route));
  check('it still returns shift_instances', /shift_instances:/.test(route));
  check('it still returns shifts', /shifts:/.test(route));
  // Tenancy is the boundary here — service-role bypasses RLS.
  check('both reads stay owner-scoped', (route.match(/\.in\('user_id', ownerIds\)/g) || []).length === 2);
  check('it is gated by requireMemberScope', /requireMemberScope\('team'\)/.test(route));
  check('explicit column lists, never select(*)', !/\.select\('\*'\)/.test(route));
}

console.log(`\n${passed} checks passed`);
