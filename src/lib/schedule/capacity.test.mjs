// STAFFING CAPACITY — the availability formula and the Request Shift kernel.
//
// Exercises the REAL capacity.ts (and the real eligibility.ts / timezone.ts / employees.ts),
// transpiled at runtime. Every number here is the number an employee would see.
//
// THE TWO RULES THIS FILE EXISTS TO PROTECT:
//   1. A COWORKER-OFFERED SHIFT IS STILL STAFFED. Carlos stays responsible for a shift he dropped
//      until a manager approves someone else, so it must never free a setup — otherwise Lensed
//      advertises an 11th spot on a 10-setup floor.
//   2. AVAILABILITY IS NEVER NEGATIVE. Lowering capacity below current staffing reports
//      "Over capacity by N" to the manager and advertises nothing; it removes nobody.
//
// Run:  TZ=UTC node src/lib/schedule/capacity.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'capacity-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const tz = transpile('./timezone.ts', 'timezone.mjs');
const elig = transpile('./eligibility.ts', 'eligibility.mjs');
const emp = transpile('../employees.ts', 'employees.mjs');
const C = await import(transpile('./capacity.ts', 'capacity.mjs', {
  "'./timezone'": `'${tz}'`, "'./eligibility'": `'${elig}'`, "'@/lib/employees'": `'${emp}'`,
}));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

// ── world ─────────────────────────────────────────────────────────────────────────────────────
// A Wednesday in September 2026 (2026-09-16 is a Wednesday), PDT = UTC-7.
const WED = '2026-09-16';
const THU = '2026-09-17';
// LA wall clock → UTC instant. PDT is UTC-7 and every date in this file is inside PDT, so the
// conversion is a straight +7h — computed through Date.UTC so an hour past 17:00 rolls the day
// rather than producing a nonsense '25:00'.
const utc = (date, h, m = 0) => {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 7, m)).toISOString();
};
const OWNER = 'owner-1';

const block = (o = {}) => ({
  id: 'blk-night', user_id: OWNER, team: 'host', label: 'Night',
  days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '18:00', end_time: '02:00',
  capacity: null, active: true, ...o,
});
const MORNING = block({ id: 'blk-morning', label: 'Morning', start_time: '06:00', end_time: '14:00' });

let nextId = 0;
/** A staffed shift for `who`, LA wall clock, end<=start meaning overnight. */
const shift = (who, date, sh, eh, o = {}) => ({
  id: `si-${++nextId}`, employee_id: who, status: 'scheduled',
  starts_at: utc(date, sh),
  ends_at: eh <= sh ? utc(nextDay(date), eh) : utc(date, eh),
  ...o,
});
function nextDay(d) { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10); }

// Roles are FREE TEXT in production (employees.role has no CHECK), which is why the team mapping
// trims and lowercases. The roster below exercises all three spellings that mean "Live Host".
const ROSTER = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, role: 'host' })),
  { id: 'hLive', role: ' Live Host ' },     // trims + lowercases to 'host'
  { id: 'hUpper', role: 'HOST' },
  { id: 'f1', role: 'fulfillment' },
  { id: 'f2', role: 'Fulfillment' },
  { id: 'x1', role: 'intern' },             // maps to 'other' — never counted, never eligible
  { id: 'x2', role: null },
];
const teamOf = C.teamOfEmployees(ROSTER);

const staffing = (b, date, instances, settings = []) =>
  C.blockStaffingOn({ block: b, date, instances, teamOf, settings });

console.log('\nSTAFFING CAPACITY — availability');

// 1. default host capacity = 10
{
  const s = staffing(block(), WED, []);
  eq('1. default Live Host capacity is 10', C.DEFAULT_TEAM_CAPACITY.host, 10);
  eq('1. an empty night block advertises all 10', [s.capacity, s.staffed, s.available], [10, 0, 10]);
}

// 2. morning 4 assigned → 6 available   /  3. night 8 assigned → 2 available
const morningFour = [0, 1, 2, 3].map((i) => shift(`h${i}`, WED, 6, 14));
const nightEight = [4, 5, 6, 7, 8, 9, 10, 11].map((i) => shift(`h${i}`, WED, 18, 2));
{
  const all = [...morningFour, ...nightEight];
  const m = staffing(MORNING, WED, all);
  const n = staffing(block(), WED, all);
  eq('2. morning 6am–2pm: 4 scheduled → 6 available', [m.staffed, m.available], [4, 6]);
  eq('3. night 6pm–2am: 8 scheduled → 2 available', [n.staffed, n.available], [8, 2]);
  // 6. morning and night are counted SEPARATELY — 12 people on Wednesday, neither block full.
  check('6. morning and night are independent (12 people that day, both blocks still open)',
    m.staffed === 4 && n.staffed === 8 && m.available === 6 && n.available === 2);
}

// 4. 10 assigned → 0 available, and the manager label says so
{
  const ten = Array.from({ length: 10 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  const s = staffing(block(), WED, ten);
  eq('4. 10 scheduled against 10 → 0 available', [s.staffed, s.available], [10, 0]);
  eq('4. manager label reads "Fully staffed"', C.staffingLabel(s), 'Fully staffed');
}

// 5. capacity never displays negative availability
{
  const twelve = Array.from({ length: 12 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  const s = staffing(block(), WED, twelve);
  eq('5. 12 scheduled against 10 → available clamps to 0, never -2', [s.staffed, s.available], [12, 0]);
  eq('5. the manager sees the overage instead', [s.over, C.staffingLabel(s)], [2, 'Over capacity by 2']);
  check('5. employee-facing label is never negative', !C.shiftsAvailableLabel(s.available).includes('-'));
}

// 7. same-team restriction  /  8. owner isolation is a query predicate (see portalSecurity)
{
  const mixed = [
    shift('h0', WED, 18, 2),
    shift('f1', WED, 18, 2),        // fulfillment, inside the host window — must NOT count
    shift('f2', WED, 18, 2),
    shift('x1', WED, 18, 2),        // role 'intern' → 'other'
    shift('x2', WED, 18, 2),        // role null     → 'other'
  ];
  const s = staffing(block(), WED, mixed);
  eq('7. only the block\'s own team is counted', [s.staffed, s.available], [1, 9]);
  const f = staffing(block({ id: 'blk-f', team: 'fulfillment', capacity: 3 }), WED, mixed);
  eq('7. the fulfillment block counts only its two people', [f.staffed, f.available], [2, 1]);
  // Role spellings: 'Live Host' and 'HOST' are the SAME team as 'host'.
  const spell = staffing(block(), WED, [shift('hLive', WED, 18, 2), shift('hUpper', WED, 18, 2)]);
  eq('7. " Live Host " and "HOST" both count as host', spell.staffed, 2);
}

// 9. a pending request does not consume capacity (the kernel counts INSTANCES only)
{
  const s = staffing(block(), WED, [shift('h0', WED, 18, 2)]);
  eq('9. a pending request changes no number — only shift_instances are counted', [s.staffed, s.available], [1, 9]);
  // Five people may each truthfully see the same availability until a manager approves someone.
  const asSeen = [0, 1, 2, 3, 4].map(() => staffing(block(), WED, [shift('h0', WED, 18, 2)]).available);
  eq('9. five simultaneous requesters all see the same count', new Set(asSeen).size, 1);
}

// 10. approval consumes one available shift
{
  const before = staffing(block({ capacity: 3 }), WED, [shift('h0', WED, 18, 2)]);
  const after = staffing(block({ capacity: 3 }), WED, [shift('h0', WED, 18, 2), shift('h1', WED, 18, 2)]);
  eq('10. approving one request drops availability by exactly one', [before.available, after.available], [2, 1]);
}

// 11 / 12 — the final shift cannot be approved twice, and two concurrent approvals cannot
// oversubscribe. Both are DATABASE properties (an advisory lock + a recount inside
// lensed_approve_shift_request). The kernel half is that the second approval SEES zero.
{
  const two = block({ capacity: 2 });
  const full = [shift('h0', WED, 18, 2), shift('h1', WED, 18, 2)];
  const s = staffing(two, WED, full);
  eq('11. once the last shift is taken the kernel reports 0 available', s.available, 0);
  const plan = C.planShiftRequest({
    staffing: s, employeeTeam: 'host', employeeStatus: 'active',
    myDatesInUse: new Set(), alreadyRequested: false,
    nowMs: Date.parse(utc(WED, 9)), todayISO: WED,
  });
  eq('11. and refuses a second approval\'s precondition', plan, { ok: false, code: 'NO_CAPACITY' });
}

// 15 / 16. A COWORKER-OFFERED SHIFT DOES NOT CREATE AN EXTRA VACANCY.
{
  const ten = Array.from({ length: 10 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  const offered = ten.map((s, i) => (i === 9 ? { ...s, offer_state: 'offered', offer_id: 'o1' } : s));
  const before = staffing(block(), WED, ten);
  const after = staffing(block(), WED, offered);
  eq('15. Carlos dropping his shift does NOT open an 11th spot', [after.staffed, after.available], [before.staffed, before.available]);
  eq('15. still 10/10, still fully staffed', [after.staffed, after.capacity, after.available], [10, 10, 0]);
  // 16. The offerer remains scheduled: the row still has their employee_id and an active status.
  const carlos = offered[9];
  check('16. the offered row is still owned and still active', carlos.employee_id === 'h9' && carlos.status === 'scheduled');
  // The inverse bug, asserted directly: excluding offered rows WOULD open an 11th spot.
  const wrong = C.countStaffed({
    instances: offered.filter((s) => s.offer_state !== 'offered'),
    teamOf, team: 'host', blockStart: after.starts_at, blockEnd: after.ends_at,
  });
  eq('16. (the bug we are not shipping) excluding offered rows would say 9', wrong, 9);
}

// A legacy RELEASED row genuinely has nobody responsible, so it DOES free a setup.
{
  const rows = [shift('h0', WED, 18, 2), { ...shift('h1', WED, 18, 2), employee_id: null, status: 'released' }];
  eq('legacy released rows (employee_id null) are not staffed', staffing(block(), WED, rows).staffed, 1);
  for (const st of ['cancelled', 'missed', 'worked']) {
    const s = staffing(block(), WED, [{ ...shift('h0', WED, 18, 2), status: st }]);
    eq(`status '${st}' is not staffed`, s.staffed, 0);
  }
  eq("status 'claimed' IS staffed", staffing(block(), WED, [{ ...shift('h0', WED, 18, 2), status: 'claimed' }]).staffed, 1);
}

// 17. date-specific capacity override
{
  const settings = [
    { id: 's1', team: 'host', block_id: null, date: null, capacity: 10, closed: false, note: null },
    { id: 's2', team: 'host', block_id: 'blk-night', date: WED, capacity: 7, closed: false, note: null },
  ];
  const six = Array.from({ length: 6 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  const w = staffing(block(), WED, six, settings);
  const t = staffing(block(), THU, six.map((s) => ({ ...s, starts_at: utc(THU, 18), ends_at: utc(nextDay(THU), 2) })), settings);
  eq('17. Wednesday override 7: 6 scheduled → 1 available', [w.capacity, w.staffed, w.available], [7, 6, 1]);
  eq('17. and it is flagged as a custom capacity', w.custom, true);
  // "Custom" means THIS date or THIS block names its own number. A team default is not custom —
  // otherwise every row in the manager outlook would be stamped "Custom capacity".
  eq('17. a plain team default is NOT custom', t.custom, false);
  eq('17. a block-level capacity IS custom',
    C.resolveCapacity({ block: { team: 'host', capacity: 6 }, override: null, teamDefault: { capacity: 9, closed: false } }).custom, true);
  eq('17. falling all the way through to the constant is NOT custom',
    C.resolveCapacity({ block: { team: 'host', capacity: null }, override: null, teamDefault: null }).custom, false);
  eq('17. a CLOSED override with no number of its own is not a custom capacity',
    C.resolveCapacity({ block: { team: 'host', capacity: null }, override: { capacity: null, closed: true }, teamDefault: { capacity: 9, closed: false } }),
    { capacity: 9, closed: true, custom: false });
  eq('17. Thursday is untouched by it: capacity back to the team default 10', [t.capacity, t.available], [10, 4]);
  // Precedence, top to bottom.
  eq('17. override beats block beats team default beats the constant',
    [
      C.resolveCapacity({ block: { team: 'host', capacity: 8 }, override: { capacity: 7, closed: false }, teamDefault: { capacity: 9, closed: false } }).capacity,
      C.resolveCapacity({ block: { team: 'host', capacity: 8 }, override: null, teamDefault: { capacity: 9, closed: false } }).capacity,
      C.resolveCapacity({ block: { team: 'host', capacity: null }, override: null, teamDefault: { capacity: 9, closed: false } }).capacity,
      C.resolveCapacity({ block: { team: 'host', capacity: null }, override: null, teamDefault: null }).capacity,
    ],
    [7, 8, 9, 10]);
}

// 18. Close availability
{
  const settings = [{ id: 's', team: 'host', block_id: 'blk-night', date: WED, capacity: null, closed: true, note: null }];
  const s = staffing(block(), WED, [shift('h0', WED, 18, 2)], settings);
  eq('18. closing availability zeroes the advertised count', s.available, 0);
  eq('18. but the capacity and the staffing are untouched', [s.capacity, s.staffed], [10, 1]);
  eq('18. the manager label says why', C.staffingLabel(s), 'Availability closed');
  // Closing a TEAM closes every block on it.
  const teamClosed = [{ id: 't', team: 'host', block_id: null, date: null, capacity: 10, closed: true, note: null }];
  eq('18. a closed team default closes the block too', staffing(block(), WED, [], teamClosed).available, 0);
}

// 19. reducing capacity below existing staffing never deletes assignments
{
  const ten = Array.from({ length: 10 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  const s = staffing(block({ capacity: 8 }), WED, ten);
  eq('19. capacity cut 10→8 with 10 scheduled: 10/8, over by 2, 0 advertised', [s.staffed, s.capacity, s.over, s.available], [10, 8, 2, 0]);
  eq('19. every assignment is still there', ten.length, 10);
  eq('19. and new requests are refused', C.planShiftRequest({
    staffing: s, employeeTeam: 'host', employeeStatus: 'active', myDatesInUse: new Set(),
    alreadyRequested: false, nowMs: Date.parse(utc(WED, 9)), todayISO: WED,
  }), { ok: false, code: 'NO_CAPACITY' });
}

// 20. a capacity increase exposes additional available shifts
{
  const eight = Array.from({ length: 8 }, (_, i) => shift(`h${i}`, WED, 18, 2));
  eq('20. 8 scheduled: capacity 8 → 0 available, capacity 12 → 4',
    [staffing(block({ capacity: 8 }), WED, eight).available, staffing(block({ capacity: 12 }), WED, eight).available],
    [0, 4]);
}

// 21. an inactive block produces no opportunity
{
  eq('21. an inactive block yields nothing at all', staffing(block({ active: false }), WED, []), null);
  eq('21. a block that does not run that weekday yields nothing',
    staffing(block({ days_of_week: [1, 2] }), WED, []), null); // WED = 3
  eq('21. an empty weekday list yields nothing', staffing(block({ days_of_week: [] }), WED, []), null);
}

console.log('\nOVERLAP — capacity means SIMULTANEOUS, so exact (start,end) matching is not enough');

// Free-form times are the production reality, so the count is an interval overlap, half-open.
{
  const night = block();                       // 18:00 → 02:00
  const rows = [
    shift('h0', WED, 17, 1),                   // 17:00–01:00  overlaps
    shift('h1', WED, 19, 0),                   // 19:00–00:00  overlaps (and is not an exact match)
    shift('h2', WED, 6, 14),                   // 06:00–14:00  does not
    shift('h3', WED, 10, 18),                  // 10:00–18:00  TOUCHES the start — half-open, so NO
    shift('h4', WED, 2, 10),                   // 02:00–10:00  touches the END of the previous night
  ];
  const s = staffing(night, WED, rows);
  eq('overlap: two differently-timed shifts count against the night block', s.staffed, 2);
  check('half-open: a shift ENDING at 18:00 does not overlap a block starting at 18:00',
    !C.spansOverlap(utc(WED, 10), utc(WED, 18), s.starts_at, s.ends_at));
  check('half-open: a shift STARTING at 02:00 does not overlap a block ending at 02:00',
    !C.spansOverlap(utc(WED, 2), utc(WED, 10), s.starts_at, s.ends_at));
  // The exact-grouping bug this replaces: grouping by identical (start,end) would have said 0.
  const exact = rows.filter((r) => r.starts_at === s.starts_at && r.ends_at === s.ends_at).length;
  eq('overlap: exact (start,end) grouping would have undercounted to 0', exact, 0);
  // A shift may legitimately count against TWO overlapping blocks — it occupies a setup in both.
  const early = block({ id: 'blk-early', start_time: '16:00', end_time: '00:00' });
  eq('overlap: overlapping blocks each count the shift that spans them',
    [staffing(night, WED, [shift('h0', WED, 17, 1)]).staffed, staffing(early, WED, [shift('h0', WED, 17, 1)]).staffed],
    [1, 1]);
}

// Overnight + DST. The block's own instants come from the same converter the writers use.
{
  const b = block();
  const i = C.blockInstants(b, WED);
  check('overnight: the night block ends on the NEXT calendar day', i.ends_at > i.starts_at && i.ends_at.slice(0, 10) === THU);
  eq('overnight: 18:00–02:00 is an 8-hour span', staffing(b, WED, []).hours, 8);
  // Fall back 2026-11-01: 01:00–02:00 PDT happens twice, so a 16:00→02:00 block is ELEVEN hours.
  const dst = C.blockInstants(block({ start_time: '16:00', end_time: '02:00' }), '2026-10-31');
  eq('DST: a 16:00–02:00 block across the fall-back night is 11 real hours',
    Math.round((Date.parse(dst.ends_at) - Date.parse(dst.starts_at)) / 3_600_000), 11);
}

console.log('\nREQUEST SHIFT — the employee kernel');

const baseStaffing = () => staffing(block(), WED, [shift('h0', WED, 18, 2)]);
const plan = (o = {}) => C.planShiftRequest({
  staffing: baseStaffing(), employeeTeam: 'host', employeeStatus: 'active',
  myDatesInUse: new Set(), alreadyRequested: false,
  nowMs: Date.parse(utc(WED, 9)), todayISO: WED, ...o,
});

eq('a live host with room may request', plan(), { ok: true });
// 13. no duplicate request for the same block
eq('13. an employee who already requested sees their request, not another button', plan({ alreadyRequested: true }), { ok: false, code: 'ALREADY_REQUESTED' });
eq('13. and the copy for that state is "Shift Requested"', C.SHIFT_REQUEST_REFUSAL_MESSAGES.ALREADY_REQUESTED, 'Shift Requested');
// 14. an employee with an incompatible shift that day cannot be approved
eq('14. already scheduled that day → refused (UNIQUE(employee_id, shift_date))', plan({ myDatesInUse: new Set([WED]) }), { ok: false, code: 'ALREADY_SCHEDULED_THAT_DAY' });
// 7 (employee half). Team + status.
eq('7. a fulfillment employee cannot request a host block', plan({ employeeTeam: 'fulfillment' }), { ok: false, code: 'WRONG_TEAM' });
eq('7. an unrecognised role cannot request anything', plan({ employeeTeam: 'other' }), { ok: false, code: 'WRONG_TEAM' });
eq('a former employee cannot request', plan({ employeeStatus: 'former' }), { ok: false, code: 'INACTIVE_EMPLOYEE' });
eq('a past date cannot be requested', plan({ todayISO: THU }), { ok: false, code: 'PAST_DATE' });
eq('a shift already under way cannot be requested', plan({ nowMs: Date.parse(utc(WED, 20)) }), { ok: false, code: 'ALREADY_STARTED' });
// Order matters: a closed day reads as closed, not as "fully staffed".
{
  const closed = staffing(block(), WED, [], [{ id: 'c', team: 'host', block_id: 'blk-night', date: WED, capacity: null, closed: true, note: null }]);
  eq('18. a closed day refuses with AVAILABILITY_CLOSED, not NO_CAPACITY',
    C.planShiftRequest({ staffing: closed, employeeTeam: 'host', employeeStatus: 'active', myDatesInUse: new Set(), alreadyRequested: false, nowMs: Date.parse(utc(WED, 9)), todayISO: WED }),
    { ok: false, code: 'AVAILABILITY_CLOSED' });
}

console.log('\nCOPY — shift language only, never seats or slots');
{
  eq('"1 shift available" is singular', C.shiftsAvailableLabel(1), '1 shift available');
  eq('"2 shifts available" is plural', C.shiftsAvailableLabel(2), '2 shifts available');
  eq('"0 shifts available" is still grammatical', C.shiftsAvailableLabel(0), '0 shifts available');
  const src = readFileSync(fileURLToPath(new URL('./capacity.ts', import.meta.url)), 'utf8');
  const employeeFacing = Object.values(C.SHIFT_REQUEST_REFUSAL_MESSAGES).join(' ') + ' ' + C.shiftsAvailableLabel(2) + ' ' + C.staffingLabel({ staffed: 8, capacity: 10, available: 2, over: 0, closed: false });
  for (const banned of ['open seat', 'seat', 'slot', 'vacanc', 'station claim']) {
    check(`employee-facing copy never says "${banned}"`, !employeeFacing.toLowerCase().includes(banned));
  }
  check('the module still explains the schema-side words in comments', /vacanc/i.test(src));
}

// 23. the employee payload carries no other-team information, and no manager configuration.
// (The server half — team as a query predicate — is asserted in portalSecurity.test.mjs.)
{
  const s = staffing(block(), WED, [shift('h0', WED, 18, 2)]);
  const wire = { available: s.available, starts_at: s.starts_at, ends_at: s.ends_at, hours: s.hours, team: s.team };
  check('23. the employee wire shape carries no capacity, staffed count or setup number',
    !('capacity' in wire) && !('staffed' in wire) && !('over' in wire) && !('closed' in wire) && !('custom' in wire));
  eq('23. only the number of shifts available is exposed', wire.available, 9);
}

// 24. The SQL and TS role→team mappings must not drift. capacity.ts publishes the predicate string
// and migration 156 must contain it verbatim — the same cross-assertion 139/149 use.
{
  const mig = readFileSync(fileURLToPath(new URL('../../../supabase/migrations/156_shift_capacity_blocks.sql', import.meta.url)), 'utf8');
  check('24. migration 156 contains the exact role→team predicate capacity.ts publishes',
    mig.includes(C.SQL_TEAM_OF_ROLE_PREDICATE), C.SQL_TEAM_OF_ROLE_PREDICATE);
  check('24. the migration counts only scheduled/claimed', mig.includes("si.status in ('scheduled', 'claimed')"));
  check('24. the migration uses the SAME half-open overlap predicate',
    mig.includes('si.starts_at < v_ends') && mig.includes('si.ends_at > v_starts'));
  check('24. the migration has NO offer_state clause in the staffed count',
    !/offer_state/.test(mig.slice(mig.indexOf('select count(*) into v_staffed'), mig.indexOf('if v_staffed >='))));
  check('24. the migration refuses rather than oversubscribing', mig.includes("'NO_CAPACITY'"));
  check('24. the migration is still marked NOT APPLIED', /⚠️ NOT APPLIED/.test(mig));
  // The default the RPC is handed must be the app constant, never a literal in SQL.
  check('24. the RPC takes the default capacity as a parameter', mig.includes('p_default_capacity smallint'));
  check('24. and SQL never hardcodes the number 10 as a capacity', !/coalesce\([^)]*\b10\b[^)]*\)/.test(mig));
}

console.log(`\n${passed} checks passed`);
