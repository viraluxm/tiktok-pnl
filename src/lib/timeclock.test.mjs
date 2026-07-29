// State-machine + derived-value proof for the employee time clock. This mirrors the DB
// RPCs in supabase/migrations/071_time_clock_rpcs.sql — the UI must never offer an action
// the server would reject, and the shift derived at clock-out must match the raw punches.
//
// No app test runner exists, so this transpiles timeclock.ts at runtime via the repo's
// `typescript` devDep (its only import is type-only, erased) and exercises the REAL logic.
//
// Run:  TZ=UTC node src/lib/timeclock.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./timeclock.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tc-')), 'timeclock.mjs');
writeFileSync(outFile, outputText);
const {
  isActionAllowed,
  blockedReason,
  nextState,
  attendanceStateOf,
  computeBreakMinutes,
  deriveTimeClockShift,
  friendlyClockError,
  teamOfRole,
  teamLabel,
  unavailableReason,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const throwsWith = (fn, token) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e.message === token;
  }
};

// ── Required state rules (mirrors the "Required state rules" spec + the RPC guards) ──
console.log('\nSt: NOT CLOCKED IN — only Clock In');
{
  check('clock_in allowed', isActionAllowed('clocked_out', 'clock_in'));
  check('start_break blocked → NOT_CLOCKED_IN', blockedReason('clocked_out', 'start_break') === 'NOT_CLOCKED_IN');
  check('end_break blocked → NO_ACTIVE_BREAK', blockedReason('clocked_out', 'end_break') === 'NO_ACTIVE_BREAK');
  check('clock_out blocked → NOT_CLOCKED_IN', blockedReason('clocked_out', 'clock_out') === 'NOT_CLOCKED_IN');
}

console.log('\nSt: WORKING — Start Break or Clock Out');
{
  check('start_break allowed', isActionAllowed('working', 'start_break'));
  check('clock_out allowed', isActionAllowed('working', 'clock_out'));
  check('clock_in blocked → ALREADY_CLOCKED_IN', blockedReason('working', 'clock_in') === 'ALREADY_CLOCKED_IN');
  check('end_break blocked → NO_ACTIVE_BREAK', blockedReason('working', 'end_break') === 'NO_ACTIVE_BREAK');
}

console.log('\nSt: ON BREAK — only End Break');
{
  check('end_break allowed', isActionAllowed('on_break', 'end_break'));
  check('clock_in blocked → ALREADY_CLOCKED_IN', blockedReason('on_break', 'clock_in') === 'ALREADY_CLOCKED_IN');
  check('start_break blocked → ALREADY_ON_BREAK', blockedReason('on_break', 'start_break') === 'ALREADY_ON_BREAK');
  check('clock_out blocked → BREAK_OPEN (must end break first)', blockedReason('on_break', 'clock_out') === 'BREAK_OPEN');
}

// ── Transitions (maps to attendance tests 1,3,5,7 — happy path) ──
console.log('\nTransitions');
{
  check('1. clock in: clocked_out → working', nextState('clocked_out', 'clock_in') === 'working');
  check('3. start break: working → on_break', nextState('working', 'start_break') === 'on_break');
  check('5. end break: on_break → working', nextState('on_break', 'end_break') === 'working');
  check('7. clock out: working → clocked_out', nextState('working', 'clock_out') === 'clocked_out');
}

// ── Rejections (maps to attendance tests 2,4,6,8) ──
console.log('\nRejections');
{
  check('2. duplicate clock-in throws ALREADY_CLOCKED_IN', throwsWith(() => nextState('working', 'clock_in'), 'ALREADY_CLOCKED_IN'));
  check('4. second break throws ALREADY_ON_BREAK', throwsWith(() => nextState('on_break', 'start_break'), 'ALREADY_ON_BREAK'));
  check('6. end nonexistent break throws NO_ACTIVE_BREAK', throwsWith(() => nextState('working', 'end_break'), 'NO_ACTIVE_BREAK'));
  check('8. clock-out on break throws BREAK_OPEN', throwsWith(() => nextState('on_break', 'clock_out'), 'BREAK_OPEN'));
  // 9. A retried clock-out once already clocked out is rejected (no second shift): mirrors
  //    the RPC finding no open entry → NOT_CLOCKED_IN → the client shows "already recorded".
  check('9. retry clock-out when clocked_out throws NOT_CLOCKED_IN', throwsWith(() => nextState('clocked_out', 'clock_out'), 'NOT_CLOCKED_IN'));
}

// ── attendanceStateOf: derive state from the open entry ──
console.log('\nattendanceStateOf');
{
  check('no open entry → clocked_out', attendanceStateOf(null) === 'clocked_out');
  check('status open → working', attendanceStateOf({ status: 'open' }) === 'working');
  check('status on_break → on_break', attendanceStateOf({ status: 'on_break' }) === 'on_break');
  check('status closed → clocked_out', attendanceStateOf({ status: 'closed' }) === 'clocked_out');
}

// ── computeBreakMinutes ──
console.log('\ncomputeBreakMinutes');
{
  const two = [
    { started_at: '2026-07-20T19:16:00Z', ended_at: '2026-07-20T19:46:00Z' }, // 30m
    { started_at: '2026-07-20T21:00:00Z', ended_at: '2026-07-20T21:15:00Z' }, // 15m
  ];
  check('two closed breaks sum to 45m', computeBreakMinutes(two) === 45, `got ${computeBreakMinutes(two)}`);
  const open = [{ started_at: '2026-07-20T19:00:00Z', ended_at: null }];
  check('open break counts up to now', computeBreakMinutes(open, Date.parse('2026-07-20T19:20:00Z')) === 20);
  check('no breaks → 0', computeBreakMinutes([]) === 0);
  // ROUNDING RULE: each endpoint is truncated to its minute (seconds dropped) before diffing.
  const secs = [{ started_at: '2026-07-20T19:16:40Z', ended_at: '2026-07-20T19:46:20Z' }]; // 29m40s raw
  check('break truncates each punch to the minute (19:16:40→19:46:20 = 30m)', computeBreakMinutes(secs) === 30, `got ${computeBreakMinutes(secs)}`);
}

// ── deriveTimeClockShift: start=clock-in, end=clock-out, break total (maps to shift tests 4,5,6) ──
console.log('\nderiveTimeClockShift (raw punches → shift row)');
{
  // 9:02 AM in → 12:16–12:48 break → 5:14 PM out, all UTC so wall-clock == the ISO time.
  const s = deriveTimeClockShift(
    '2026-07-20T09:02:37Z', // :37s — dropped
    '2026-07-20T17:14:50Z', // :50s — dropped
    [{ started_at: '2026-07-20T12:16:40Z', ended_at: '2026-07-20T12:48:20Z' }], // seconds on each end
    'UTC',
  );
  check('4. start_time = clock-in truncated to the minute (09:02:00, :37 dropped)', s.start_time === '09:02:00', s.start_time);
  check('5. end_time = clock-out truncated to the minute (17:14:00, :50 dropped)', s.end_time === '17:14:00', s.end_time);
  check('6. break_minutes = 32 (each break punch truncated to the minute)', s.break_minutes === 32, String(s.break_minutes));
  check('date is the clock-in date', s.date === '2026-07-20', s.date);

  // CONSISTENCY: seconds are dropped IDENTICALLY on clock-in, clock-out, and break endpoints,
  // so the whole shift is minute-aligned and pay can never differ by a stray second.
  const consistent = deriveTimeClockShift(
    '2026-07-20T09:00:59Z',
    '2026-07-20T17:00:01Z',
    [{ started_at: '2026-07-20T12:00:59Z', ended_at: '2026-07-20T12:30:59Z' }],
    'UTC',
  );
  check('consistent: start 09:00:00', consistent.start_time === '09:00:00', consistent.start_time);
  check('consistent: end 17:00:00', consistent.end_time === '17:00:00', consistent.end_time);
  check('consistent: break 30m (12:00:59→12:30:59, seconds dropped both sides)', consistent.break_minutes === 30, String(consistent.break_minutes));

  // Same instants read in America/Los_Angeles (UTC-7 in July): times shift by 7h, date holds.
  const la = deriveTimeClockShift('2026-07-20T18:00:00Z', '2026-07-20T22:30:00Z', [], 'America/Los_Angeles');
  check('LA tz: 18:00Z → 11:00:00 local', la.start_time === '11:00:00', la.start_time);
  check('LA tz: 22:30Z → 15:30:00 local', la.end_time === '15:30:00', la.end_time);

  // Overnight: clock-in date is kept; the wall times cross midnight.
  const overnight = deriveTimeClockShift('2026-07-20T23:30:00Z', '2026-07-21T01:15:00Z', [], 'UTC');
  check('overnight keeps clock-in date', overnight.date === '2026-07-20', overnight.date);
  check('overnight end wraps to 01:15:00', overnight.end_time === '01:15:00', overnight.end_time);
}

// ── friendly, employee-named messages (spec examples) ──
console.log('\nfriendlyClockError');
{
  check('ALREADY_CLOCKED_IN', friendlyClockError('ALREADY_CLOCKED_IN', 'Maria') === 'Maria is already clocked in.');
  check('NO_ACTIVE_BREAK', friendlyClockError('NO_ACTIVE_BREAK', 'Maria') === 'Maria does not have an active break.');
  check("BREAK_OPEN", friendlyClockError('BREAK_OPEN', 'Maria') === "Please end Maria's break before clocking out.");
  check('clock_out + NOT_CLOCKED_IN → already recorded', friendlyClockError('NOT_CLOCKED_IN', 'Maria', 'clock_out') === 'This action was already recorded.');
}

// ── team matching (kiosk employee picker) — case-insensitive, safe 'other' fallback ──
console.log('\nteamOfRole + teamLabel');
{
  check("'host' → host", teamOfRole('host') === 'host');
  check("'Host' (caps) → host", teamOfRole('Host') === 'host');
  check("' live host ' (spaces/caps) → host", teamOfRole(' Live Host ') === 'host');
  check("'fulfillment' → fulfillment", teamOfRole('fulfillment') === 'fulfillment');
  check("'Fulfillment' → fulfillment", teamOfRole('Fulfillment') === 'fulfillment');
  check("'manager' → other", teamOfRole('manager') === 'other');
  check("'' → other", teamOfRole('') === 'other');
  check('null/undefined → other', teamOfRole(null) === 'other' && teamOfRole(undefined) === 'other');
  check("unexpected free text → other (never hidden)", teamOfRole('Warehouse Lead') === 'other');
  check("teamLabel(host) = 'Live Host'", teamLabel('host') === 'Live Host');
  check("teamLabel(fulfillment) = 'Fulfillment'", teamLabel('fulfillment') === 'Fulfillment');
  check("teamLabel(other) = 'Other'", teamLabel('other') === 'Other');
}

// ── unavailableReason: short employee-facing text for a disabled card (null = allowed) ──
console.log('\nunavailableReason');
{
  check('working + clock_in → Already clocked in', unavailableReason('working', 'clock_in') === 'Already clocked in');
  check('on_break + clock_in → Already clocked in', unavailableReason('on_break', 'clock_in') === 'Already clocked in');
  check('clocked_out + start_break → Not currently clocked in', unavailableReason('clocked_out', 'start_break') === 'Not currently clocked in');
  check('on_break + start_break → Currently on break', unavailableReason('on_break', 'start_break') === 'Currently on break');
  check('working + end_break → No active break', unavailableReason('working', 'end_break') === 'No active break');
  check('on_break + clock_out → Currently on break', unavailableReason('on_break', 'clock_out') === 'Currently on break');
  check('working + clock_out allowed → null', unavailableReason('working', 'clock_out') === null);
  check('clocked_out + clock_in allowed → null', unavailableReason('clocked_out', 'clock_in') === null);
}

console.log(`\nALL PASSED (${passed} assertions)`);
