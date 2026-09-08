// portalModel: the pure view-model behind the employee portal's Home / Schedule / Requests.
//
// Exercises the REAL portalModel.ts (with the real timezone.ts, hours.ts and employees.ts),
// transpiled at runtime. Every instant below is written with an explicit LA offset so the
// assertions do not depend on the runner's zone (run.sh pins TZ=UTC anyway).
//
// Run:  TZ=UTC node src/lib/schedule/portalModel.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'portalmodel-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const timezone = transpile('./timezone.ts', 'timezone.mjs');
const employees = transpile('../employees.ts', 'employees.mjs');
const hours = transpile('./hours.ts', 'hours.mjs', { "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'` });
const M = await import(transpile('./portalModel.ts', 'portalModel.mjs', { "'./timezone'": `'${timezone}'`, "'./hours'": `'${hours}'` }));

let passed = 0;
const check = (n, c, e = '') => { assert.ok(c, `FAIL: ${n} ${e}`); console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); passed++; };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

// Tuesday 2026-09-08, 10:30 AM PDT.
const TODAY = '2026-09-08';
const NOW = Date.parse('2026-09-08T10:30:00-07:00');
const shift = (o = {}) => ({
  id: 'i1', shift_date: '2026-09-08', starts_at: '2026-09-08T18:00:00-07:00', ends_at: '2026-09-09T02:00:00-07:00',
  status: 'scheduled', role: 'host', hours: 8, offer_state: null, offer_id: null, trade: null, ...o,
});

console.log('\n1. GREETING — business-local hour, first name');
{
  eq('10:30 PDT → 10', M.laHourOf(NOW), 10);
  eq('01:30 UTC is still 6:30 PM PDT the day before → 18', M.laHourOf(Date.parse('2026-09-09T01:30:00Z')), 18);
  eq('morning', M.greetingFor(9, 'Carlos Ruiz'), 'Good morning, Carlos');
  eq('afternoon at exactly noon', M.greetingFor(12, 'Carlos'), 'Good afternoon, Carlos');
  eq('evening at 17', M.greetingFor(17, 'Carlos'), 'Good evening, Carlos');
  eq('small hours', M.greetingFor(3, 'Carlos'), 'Still up, Carlos?');
  eq('empty name falls back', M.firstNameOf('  '), 'there');
}

console.log('\n2. FORMATTING — LA times, calendar labels, hours');
{
  eq('range 6:00 PM – 2:00 AM', M.fmtRangeLA('2026-09-08T18:00:00-07:00', '2026-09-09T02:00:00-07:00'), '6:00 PM – 2:00 AM');
  eq('overnight detected in LA', M.crossesMidnightLA('2026-09-08T18:00:00-07:00', '2026-09-09T02:00:00-07:00'), true);
  eq('same LA day even though UTC date differs', M.crossesMidnightLA('2026-09-08T16:00:00-07:00', '2026-09-08T23:30:00-07:00'), false);
  eq('40 → "40 hrs"', M.fmtHours(40), '40 hrs');
  eq('31.5 → "31.5 hrs"', M.fmtHours(31.5), '31.5 hrs');
  eq('8.25 → "8.25 hrs"', M.fmtHours(8.25), '8.25 hrs');
  eq('1 → "1 hr"', M.fmtHours(1), '1 hr');
  eq('8.1 → "8h 06m"', M.fmtDuration(8.1), '8h 06m');
  eq('0 → "0h 00m"', M.fmtDuration(0), '0h 00m');
  eq('MON/TUE labels', [M.dowShort('2026-09-07'), M.dowShort('2026-09-13')], ['MON', 'SUN']);
  eq('long date', M.fmtLongDate('2026-09-08'), 'Tuesday, September 8');
  eq('Today / Tomorrow / Yesterday / weekday', [
    M.relativeDayLabel('2026-09-08', TODAY), M.relativeDayLabel('2026-09-09', TODAY),
    M.relativeDayLabel('2026-09-07', TODAY), M.relativeDayLabel('2026-09-10', TODAY),
  ], ['Today', 'Tomorrow', 'Yesterday', 'Thursday']);
  eq('role labels', [M.roleLabel('host'), M.roleLabel('fulfillment'), M.roleLabel('Live host'), M.roleLabel(null)], ['Live Host', 'Fulfillment', 'Live Host', '']);
  eq('valid date', M.isValidDateISO('2026-09-08'), true);
  eq('rolled-over date rejected', M.isValidDateISO('2026-02-31'), false);
}

console.log('\n3. NEXT SHIFT — in progress wins; an ended shift today is never next');
{
  const later = shift({ id: 'i2', shift_date: '2026-09-10', starts_at: '2026-09-10T06:00:00-07:00', ends_at: '2026-09-10T14:00:00-07:00' });
  const n = M.pickNextShift([later, shift()], NOW, TODAY);
  eq('today\'s 6 PM shift is next (sorted by start, not input order)', n.shift.id, 'i1');
  eq('when=today', n.when, 'today');
  eq('minutes until = 450', n.minutesUntil, 450);
  eq('hint says hours', M.nextShiftHint(n), 'Starts in 8 hrs');

  const ended = shift({ id: 'i0', starts_at: '2026-09-08T01:00:00-07:00', ends_at: '2026-09-08T09:00:00-07:00' });
  eq('an ended shift today is skipped', M.pickNextShift([ended, later], NOW, TODAY).shift.id, 'i2');
  eq('…and the later one is "later" (Thursday)', M.pickNextShift([ended, later], NOW, TODAY).when, 'later');

  const live = shift({ starts_at: '2026-09-08T09:00:00-07:00', ends_at: '2026-09-08T17:00:00-07:00' });
  const l = M.pickNextShift([live, later], NOW, TODAY);
  eq('in-progress shift is "now"', l.when, 'now');
  eq('hint = In progress', M.nextShiftHint(l), 'In progress');
  eq('tomorrow', M.pickNextShift([shift({ shift_date: '2026-09-09', starts_at: '2026-09-09T06:00:00-07:00', ends_at: '2026-09-09T14:00:00-07:00' })], NOW, TODAY).when, 'tomorrow');
  eq('nothing upcoming → null', M.pickNextShift([ended], NOW, TODAY), null);
  eq('20 minutes out says minutes', M.nextShiftHint({ when: 'today', minutesUntil: 20 }), 'Starts in 20 min');
}

console.log('\n4. CLOCK WINDOW — mirrors the server gate [start−45m, end+60m]');
{
  const s = shift();
  eq('46 min before start → outside', M.inClockWindow(s, Date.parse('2026-09-08T17:14:00-07:00')), false);
  eq('45 min before start → inside', M.inClockWindow(s, Date.parse('2026-09-08T17:15:00-07:00')), true);
  eq('60 min after end → inside', M.inClockWindow(s, Date.parse('2026-09-09T03:00:00-07:00')), true);
  eq('61 min after end → outside', M.inClockWindow(s, Date.parse('2026-09-09T03:01:00-07:00')), false);
}

console.log('\n5. WEEK STRIP — seven cells, today/selected/scheduled/next/offered flags');
{
  const cells = M.weekStripModel({
    weekStart: '2026-09-07', todayISO: TODAY, selected: '2026-09-10',
    shiftsByDate: new Map([['2026-09-08', { offer_state: null }], ['2026-09-10', { offer_state: 'offered' }]]),
    nextShiftDate: '2026-09-08',
  });
  eq('7 cells Mon→Sun', cells.map((c) => c.dow), ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
  eq('day numbers', cells.map((c) => c.day), [7, 8, 9, 10, 11, 12, 13]);
  eq('today = TUE only', cells.filter((c) => c.isToday).map((c) => c.date), ['2026-09-08']);
  eq('selected = THU only', cells.filter((c) => c.isSelected).map((c) => c.date), ['2026-09-10']);
  eq('MON is past, WED is not', [cells[0].isPast, cells[2].isPast], [true, false]);
  eq('shift dots on TUE + THU', cells.filter((c) => c.hasShift).map((c) => c.dow), ['TUE', 'THU']);
  eq('next flag on TUE', cells.filter((c) => c.isNext).map((c) => c.dow), ['TUE']);
  eq('offered flag on THU', cells.filter((c) => c.isOffered).map((c) => c.dow), ['THU']);
  eq('mondayOf a Sunday is the previous Monday', M.mondayOf('2026-09-13'), '2026-09-07');
  eq('mondayOf a Monday is itself', M.mondayOf('2026-09-07'), '2026-09-07');
  eq('default day: today when in week', M.defaultSelectedDay('2026-09-07', TODAY, new Set()), TODAY);
  eq('default day: first scheduled day in another week', M.defaultSelectedDay('2026-09-14', TODAY, new Set(['2026-09-16'])), '2026-09-16');
  eq('default day: Monday when nothing scheduled', M.defaultSelectedDay('2026-09-14', TODAY, new Set()), '2026-09-14');
}

console.log('\n6. SCHEDULED HOURS — planned only, inside the window');
{
  const rows = [shift({ shift_date: '2026-09-07', hours: 8 }), shift({ shift_date: '2026-09-13', hours: 8 }), shift({ shift_date: '2026-09-14', hours: 8 })];
  eq('Mon..Sun sums two, excludes next Monday', M.scheduledHoursBetween(rows, '2026-09-07', '2026-09-13'), 16);
}

const snap = (o = {}) => ({
  employee: { name: 'Carlos Ruiz', role: 'host', shortId: 'abcd1234', status: 'active' },
  todayISO: TODAY, generatedAt: new Date(NOW).toISOString(),
  upcoming: [], releasedByMe: [],
  thisWeek: { start: '2026-09-07', end: '2026-09-13', scheduledHours: 40, workedHours: 31.5, pendingHours: 0 },
  payPeriod: { start: '2026-08-31', end: '2026-09-13', workedHours: 72, pendingHours: 0 },
  clock: { state: 'clocked_out', clockedInAt: null },
  available: [], pickups: [], otClaims: [], timeOff: [], timeOffEarliest: '2026-09-14', trades: [],
  drops: { used: 0, cap: 2, excused: 0 }, ...o,
});
const trade = (o = {}) => ({
  id: 't1', status: 'pending_coworker', direction: 'incoming', other_name: 'Juan Perez',
  my_shift: { instance_id: 'm', shift_date: '2026-09-10', starts_at: '2026-09-10T18:00:00-07:00', ends_at: '2026-09-11T02:00:00-07:00', hours: 8 },
  their_shift: { instance_id: 't', shift_date: '2026-09-11', starts_at: '2026-09-11T06:00:00-07:00', ends_at: '2026-09-11T14:00:00-07:00', hours: 8 },
  created_at: '2026-09-07T12:00:00-07:00', coworker_response: null, coworker_responded_at: null, decided_at: null, decision_note: null, cancelled_at: null, ...o,
});

console.log('\n7. ALERTS — only real conditions, actionable first, recent decisions only');
{
  eq('nothing going on → no alerts', M.buildAlerts(snap(), NOW), []);
  const a = M.buildAlerts(snap({
    trades: [trade(), trade({ id: 't2', direction: 'outgoing', status: 'pending_manager', coworker_response: 'accepted' })],
    upcoming: [shift({ shift_date: '2026-09-10', offer_state: 'offered', offer_id: 'o1' })],
    pickups: [{ claim_id: 'c1', shift_instance_id: 'x', shift_date: '2026-09-12', starts_at: '2026-09-12T06:00:00-07:00', ends_at: '2026-09-12T14:00:00-07:00', status: 'pending', requested_at: '2026-09-07T12:00:00-07:00', decided_at: null }],
    timeOff: [
      { id: 'to1', start_date: '2026-09-18', end_date: '2026-09-20', reason: null, status: 'approved', decision_note: null, created_at: '2026-09-01T00:00:00Z', decided_at: '2026-09-07T20:00:00Z' },
      { id: 'to2', start_date: '2026-08-01', end_date: '2026-08-01', reason: null, status: 'denied', decision_note: null, created_at: '2026-07-01T00:00:00Z', decided_at: '2026-07-20T20:00:00Z' },
    ],
    available: [
      { kind: 'offer', id: 'a1', offer_id: 'oa', shift_date: '2026-09-12', starts_at: '', ends_at: '', role: 'host', hours: 8, offered_by_name: 'Ana', refusal: null, requested: false },
      { kind: 'offer', id: 'a2', offer_id: 'ob', shift_date: '2026-09-12', starts_at: '', ends_at: '', role: 'host', hours: 8, offered_by_name: 'Ana', refusal: "You're already scheduled that day.", requested: false },
    ],
  }), NOW);
  eq('kinds in priority order', a.map((x) => x.kind), ['trade_incoming', 'offered_still_yours', 'pickup_waiting', 'trade_waiting_manager', 'time_off_decided', 'open_shifts']);
  eq('only the incoming trade is actionable', a.filter((x) => x.actionable).map((x) => x.id), ['trade-in-t1']);
  check('incoming trade names the coworker', a[0].title === 'Juan sent you a trade request', a[0].title);
  check('offered alert says still responsible', a[1].body.includes('still responsible'), a[1].body);
  check('old denial (7+ days) is NOT an alert', !a.some((x) => x.id === 'timeoff-to2'));
  eq('open shift count excludes refused ones', a.at(-1).title, '1 open shift available');
  eq('offered alert routes to Schedule → My Shifts', a[1].go, { tab: 'schedule', seg: 'mine' });
}

console.log('\n8. REQUESTS GROUPING — action / pending / history');
{
  const g = M.groupRequests(snap({
    trades: [
      trade(),                                                                                  // incoming, needs me → action
      trade({ id: 't2', direction: 'outgoing' }),                                              // waiting for Juan → pending
      trade({ id: 't3', direction: 'outgoing', status: 'approved', decided_at: '2026-09-06T00:00:00Z' }),
      trade({ id: 't4', direction: 'incoming', status: 'declined', coworker_response: 'declined', coworker_responded_at: '2026-09-05T00:00:00Z' }),
    ],
    timeOff: [{ id: 'to1', start_date: '2026-09-18', end_date: '2026-09-20', reason: 'trip', status: 'pending', decision_note: null, created_at: '2026-09-02T00:00:00Z', decided_at: null }],
    pickups: [{ claim_id: 'c1', shift_instance_id: 'x', shift_date: '2026-09-12', starts_at: '2026-09-12T06:00:00-07:00', ends_at: '2026-09-12T14:00:00-07:00', status: 'rejected', requested_at: '2026-09-01T00:00:00Z', decided_at: '2026-09-07T00:00:00Z' }],
    otClaims: [{ claim_id: 'ot1', shift_date: '2026-09-15', starts_at: '2026-09-15T06:00:00-07:00', ends_at: '2026-09-15T14:00:00-07:00', projected_week_hours: 44 }],
  }));
  eq('action = the incoming pending trade', g.action.map((x) => x.key), ['trade-t1']);
  eq('pending = time off (Sep 2), outgoing trade (Sep 7), OT claim (Sep 15) — oldest first', g.pending.map((x) => x.key), ['to-to1', 'trade-t2', 'ot-ot1']);
  eq('history newest first', g.history.map((x) => x.key), ['pk-c1', 'trade-t3', 'trade-t4']);
  eq('badge count = 1', M.actionCount(snap({ trades: [trade(), trade({ id: 't2', direction: 'outgoing' })] })), 1);
}

console.log('\n9. STATUS WORDS — plain sentences, never a code');
{
  eq('outgoing waiting', M.tradeStatusWords(trade({ direction: 'outgoing' })), 'Waiting for Juan');
  eq('incoming needs answer', M.tradeStatusWords(trade()), 'Needs your answer');
  eq('pending manager', M.tradeStatusWords(trade({ status: 'pending_manager' })), 'Waiting for manager approval');
  eq('declined by coworker', M.tradeStatusWords(trade({ status: 'declined', coworker_response: 'declined' })), 'Declined by Juan');
  eq('declined by manager', M.tradeStatusWords(trade({ status: 'declined', coworker_response: 'accepted' })), 'Declined by manager');
  eq('time off denied reads "Declined"', M.timeOffStatusWords({ status: 'denied' }), 'Declined');
  eq('pickup superseded is honest', M.pickupStatusWords({ status: 'superseded' }), 'Went to someone else');
}

console.log(`\n${passed} checks passed`);
