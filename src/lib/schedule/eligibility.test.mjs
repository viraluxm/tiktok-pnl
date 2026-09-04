// Proof for the admin-open shift kernels (migration 090): the role a released/open shift represents,
// the status+role plan for a one-time admin shift, and the overnight roll. Transpiles eligibility.ts
// (no imports) at runtime — same pattern as otGate.test.mjs.
// Run:  node src/lib/schedule/eligibility.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./eligibility.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'elig-')), 'eligibility.mjs');
writeFileSync(outFile, outputText);
const {
  effectiveShiftRole, planAdminShift, crossesMidnight, scheduleIsEmpty,
  planShiftRemoval, SHIFT_REMOVAL_MESSAGES,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

console.log('\neffectiveShiftRole — the role a board/claim shift represents');
// Released pattern shift: role comes from the RELEASER, NOT the (null) row role.
check('released shift → releaser role', effectiveShiftRole({ released_by: 'e1', source: 'claim', role: null }, 'host') === 'host');
check('released shift, releaser is fulfillment', effectiveShiftRole({ released_by: 'e2', source: 'pattern', role: null }, 'fulfillment') === 'fulfillment');
check('released shift, releaser unresolved → null', effectiveShiftRole({ released_by: 'e3', source: 'pattern', role: null }, null) === null);
// Admin open shift: no releaser → role is the row's OWN column.
check('admin_open unassigned → row role (host)', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'host' }, null) === 'host');
check('admin_open unassigned → row role (fulfillment)', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'fulfillment' }, null) === 'fulfillment');
// Malformed: released row with neither releaser nor admin_open source → not claimable.
check('released, no releaser, not admin_open → null', effectiveShiftRole({ released_by: null, source: 'pattern', role: null }, null) === null);
// A released admin_open row ignores any stray releaser lookup ordering: released_by wins first, but
// admin_open rows never have released_by, so this stays the row role.
check('admin_open never derives from a releaser', effectiveShiftRole({ released_by: null, source: 'admin_open', role: 'host' }, 'fulfillment') === 'host');

console.log('\nplanAdminShift — status + role for a one-time admin shift');
// Assigned: status scheduled; role = employee role; typed role ignored (no mismatch possible).
const a1 = planAdminShift({ employeeRole: 'host', role: null });
check('assigned → scheduled + employee role', a1.ok && a1.status === 'scheduled' && a1.role === 'host');
const a2 = planAdminShift({ employeeRole: 'fulfillment', role: 'host' });
check('assigned ignores typed role (uses employee)', a2.ok && a2.role === 'fulfillment', `got ${a2.role}`);
// Unassigned: status released; role required + must be a valid class.
const u1 = planAdminShift({ employeeRole: null, role: 'host' });
check('unassigned + host → released + host', u1.ok && u1.status === 'released' && u1.role === 'host');
const u2 = planAdminShift({ employeeRole: null, role: 'fulfillment' });
check('unassigned + fulfillment → released', u2.ok && u2.status === 'released' && u2.role === 'fulfillment');
const u3 = planAdminShift({ employeeRole: null, role: null });
check('unassigned + no role → ROLE_REQUIRED', !u3.ok && u3.error === 'ROLE_REQUIRED');
const u4 = planAdminShift({ employeeRole: null, role: 'manager' });
check('unassigned + invalid role → ROLE_REQUIRED', !u4.ok && u4.error === 'ROLE_REQUIRED');

console.log('\ncrossesMidnight — overnight roll');
check('09:00→17:00 same day', crossesMidnight('09:00', '17:00') === false);
check('22:00→02:00 overnight', crossesMidnight('22:00', '02:00') === true);
check('20:00→08:00 overnight', crossesMidnight('20:00', '08:00') === true);
// end == start is caller-rejected before this runs, but the predicate treats it as overnight (<=).
check('equal times → treated as overnight by <= (caller rejects first)', crossesMidnight('10:00', '10:00') === true);

console.log('\nscheduleIsEmpty — /s empty state is a fallback, NOT a rules gate');
// The bug: /s gated on hasActiveRules, so these no-rules employees saw nothing. scheduleIsEmpty
// takes ONLY content counts — rules are not an input, so they can no longer hide anything.
// Case 1: no rules + one assigned one-time shift → NOT empty (renders under Your shifts).
check('no rules + assigned one-time shift → renders', scheduleIsEmpty({ myShifts: 1, board: 0, pending: 0 }) === false);
// Case 2: no rules + a matching-role board shift → NOT empty (board renders with Claim).
check('no rules + board shift → renders', scheduleIsEmpty({ myShifts: 0, board: 1, pending: 0 }) === false);
// Case 3: no rules + nothing at all → empty state.
check('no rules + nothing → empty state', scheduleIsEmpty({ myShifts: 0, board: 0, pending: 0 }) === true);
// Case 4: has rules → unchanged: a materialized shift means myShifts>0 → renders exactly as before.
check('has rules (materialized shift present) → renders', scheduleIsEmpty({ myShifts: 3, board: 0, pending: 0 }) === false);
// A pending OT claim alone is also enough to render (the claimer must see it in-flight).
check('pending claim only → renders', scheduleIsEmpty({ myShifts: 0, board: 0, pending: 1 }) === false);

console.log('\nplanShiftRemoval — Remove Shift is for an UNTOUCHED FUTURE ONE-OFF PLAN only');
// Facts are supplied as epoch millis from the row's authoritative starts_at, so no calendar-day /
// UTC assumption can enter the decision. NOW is frozen for the whole block.
const NOW = Date.parse('2026-09-10T12:00:00Z');
const HR = 3600_000;
const base = {
  source: 'admin_open', status: 'scheduled',
  startsAtMs: NOW + 48 * HR, nowMs: NOW,
  hasWorkedShift: false, hasOpenPunch: false,
};
const plan = (o = {}) => planShiftRemoval({ ...base, ...o });

// ── the one allowed case ──
check('admin_open + scheduled + future + no punch + no worked shift → ALLOWED', plan().ok === true);
// One minute in the future is still the future — the boundary is the instant, not the day.
check('one minute in the future → allowed', plan({ startsAtMs: NOW + 60_000 }).ok === true);

// ── refusals: not a one-off plan ──
const rPattern = plan({ source: 'pattern' });
check('pattern → NOT_ONE_OFF (materializer would regenerate it)', !rPattern.ok && rPattern.code === 'NOT_ONE_OFF');
const rClaim = plan({ source: 'claim' });
check('claim → NOT_ONE_OFF (carries a shift_claims OT trail)', !rClaim.ok && rClaim.code === 'NOT_ONE_OFF');

// ── refusals: not still merely scheduled ──
for (const st of ['released', 'claimed', 'worked', 'missed', 'cancelled']) {
  const r = plan({ status: st });
  check(`status '${st}' → NOT_SCHEDULED`, !r.ok && r.code === 'NOT_SCHEDULED');
}

// ── refusals: time ──
const rPast = plan({ startsAtMs: NOW - 24 * HR });
check('past shift → ALREADY_STARTED', !rPast.ok && rPast.code === 'ALREADY_STARTED');
const rNow = plan({ startsAtMs: NOW });
check('starts exactly now → ALREADY_STARTED (boundary is inclusive)', !rNow.ok && rNow.code === 'ALREADY_STARTED');
const rStarted = plan({ startsAtMs: NOW - 60_000 });
check('started a minute ago → ALREADY_STARTED', !rStarted.ok && rStarted.code === 'ALREADY_STARTED');
// Fails CLOSED: an unparseable instant must never read as "safe to delete".
const rNaN = plan({ startsAtMs: Number.NaN });
check('unparseable starts_at → refused, not allowed (fail closed)', !rNaN.ok && rNaN.code === 'ALREADY_STARTED');

// ── refusals: a payroll record already refers to this employee/date ──
const rWorked = plan({ hasWorkedShift: true });
check('worked `shifts` row on that employee+date → WORKED_TIME_EXISTS', !rWorked.ok && rWorked.code === 'WORKED_TIME_EXISTS');
const rPunch = plan({ hasOpenPunch: true });
check('employee currently clocked in → EMPLOYEE_CLOCKED_IN', !rPunch.ok && rPunch.code === 'EMPLOYEE_CLOCKED_IN');

// ── precedence: the structural reason wins, so the message explains the real blocker ──
const rBoth = plan({ source: 'pattern', hasOpenPunch: true, startsAtMs: NOW - HR });
check('recurring + started + clocked in → reports NOT_ONE_OFF first', !rBoth.ok && rBoth.code === 'NOT_ONE_OFF');
const rWorkedBeatsPunch = plan({ hasWorkedShift: true, hasOpenPunch: true });
check('worked shift outranks open punch', !rWorkedBeatsPunch.ok && rWorkedBeatsPunch.code === 'WORKED_TIME_EXISTS');

// Every refusal code must have a manager-readable sentence — a missing one would render "undefined".
for (const code of ['NOT_ONE_OFF', 'NOT_SCHEDULED', 'ALREADY_STARTED', 'WORKED_TIME_EXISTS', 'EMPLOYEE_CLOCKED_IN']) {
  check(`SHIFT_REMOVAL_MESSAGES has ${code}`, typeof SHIFT_REMOVAL_MESSAGES[code] === 'string' && SHIFT_REMOVAL_MESSAGES[code].length > 10);
}

console.log(`\nALL PASSED (${passed} assertions)`);
