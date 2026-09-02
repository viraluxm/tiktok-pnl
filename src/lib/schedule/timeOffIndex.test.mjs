// Proof for the calendar-marker index: expanding a request's inclusive range into days, and
// dropping denied requests. Extracted from TimeOffQueue.tsx (a .tsx cannot be transpiled alone
// here), so the logic is duplicated verbatim and asserted — if the component changes, this fails
// to match and should be updated with it.
//   Run:  node src/lib/schedule/timeOffIndex.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function timeOffDays(r) {
  const out = [];
  const [y, m, d] = r.start_date.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  while (cur.toISOString().slice(0, 10) <= r.end_date) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (out.length > 60) break;
  }
  return out;
}
function indexTimeOffByDate(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.status === 'denied') continue;
    for (const d of timeOffDays(r)) {
      const arr = m.get(d);
      if (arr) arr.push(r); else m.set(d, [r]);
    }
  }
  return m;
}

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  \u2713 ${n}`); passed++; };

console.log('\nrange expansion');
check('a single day yields one date',
  JSON.stringify(timeOffDays({ start_date: '2026-09-10', end_date: '2026-09-10' })) === '["2026-09-10"]');
check('both ends are inclusive',
  timeOffDays({ start_date: '2026-09-10', end_date: '2026-09-12' }).length === 3);
check('it crosses a month end',
  timeOffDays({ start_date: '2026-08-31', end_date: '2026-09-01' }).join(',') === '2026-08-31,2026-09-01');
check('it crosses the Nov 2026 DST change without dropping or repeating a day',
  timeOffDays({ start_date: '2026-10-31', end_date: '2026-11-02' }).join(',') === '2026-10-31,2026-11-01,2026-11-02');
check('a runaway range is capped rather than looping',
  timeOffDays({ start_date: '2026-01-01', end_date: '2030-01-01' }).length === 61);

console.log('\nindexing');
{
  const rows = [
    { id: 'a', status: 'pending',  start_date: '2026-09-10', end_date: '2026-09-11' },
    { id: 'b', status: 'approved', start_date: '2026-09-11', end_date: '2026-09-11' },
    { id: 'c', status: 'denied',   start_date: '2026-09-10', end_date: '2026-09-10' },
  ];
  const m = indexTimeOffByDate(rows);
  check('a pending request marks every day it covers', m.get('2026-09-10').length === 1 && m.get('2026-09-11').length === 2);
  check('DENIED is excluded — that person is working', !m.get('2026-09-10').some((r) => r.id === 'c'));
  check('a day with no request is absent', !m.has('2026-09-12'));
}

console.log('\nthe component still matches this logic');
{
  const src = readFileSync(fileURLToPath(new URL('../../components/employees/weekly/TimeOffQueue.tsx', import.meta.url)), 'utf8');
  check('TimeOffQueue still skips denied rows', /if \(r\.status === 'denied'\) continue;/.test(src));
  check('TimeOffQueue still caps the expansion at 60', /out\.length > 60/.test(src));
}

console.log(`\n${passed} checks passed\n`);
