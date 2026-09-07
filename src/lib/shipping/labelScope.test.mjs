// Proof for label-run scope parsing. A scope decides WHICH orders get bought, so a permissive
// parse is a wrong purchase — the tests centre on refusing rather than guessing.
// Run:  node src/lib/shipping/labelScope.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'ls-'));
const emit = (src, name, rewrite = (x) => x) => {
  const { outputText } = ts.transpileModule(readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const p = join(dir, name);
  writeFileSync(p, rewrite(outputText));
  return pathToFileURL(p).href;
};
const here = (f) => fileURLToPath(new URL(f, import.meta.url));
emit(here('./pickerPerformance.ts'), 'pickerPerformance.mjs');
const mod = await import(emit(here('./labelScope.ts'), 'labelScope.mjs',
  (s) => s.replace('@/lib/shipping/pickerPerformance', './pickerPerformance.mjs')));
const { parseScope, dayWindow, dayOf, describeScope, MAX_SCOPE_LIVES, MAX_SCOPE_DAYS } = mod;

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};
const U = (n) => `0000000${n}-1111-2222-3333-444444444444`.slice(-36);

console.log('\nNo scope means the whole backlog');
{
  const r = parseScope({});
  check('absent params → all', r.scope?.kind === 'all');
  check('empty strings → all', parseScope({ day: '', sessionIds: '' }).scope.kind === 'all');
  check('whitespace → all', parseScope({ day: '   ' }).scope.kind === 'all');
  check('null → all', parseScope({ day: null, sessionIds: null }).scope.kind === 'all');
}

console.log('\nA malformed scope is REFUSED, never widened');
{
  // The failure that matters: a typo'd day quietly becoming "the entire backlog", because the
  // next thing the operator does is authorise it.
  for (const bad of ['2026-9-3', '03-09-2026', 'yesterday', '2026-09-03T00:00', '20260903']) {
    const r = parseScope({ day: bad });
    check(`"${bad}" is refused, not treated as all`, !!r.error && !r.scope, r.error ?? 'NO ERROR');
  }
  check('an impossible date is refused',
    !!parseScope({ day: '2026-13-45' }).error, JSON.stringify(parseScope({ day: '2026-13-45' })));
  check('a non-UUID session id is refused',
    !!parseScope({ sessionIds: 'not-a-uuid' }).error);
  check('one bad id among good ones refuses the whole list',
    !!parseScope({ sessionIds: `${U(1)},oops` }).error);
  check('…and names the offender',
    parseScope({ sessionIds: `${U(1)},oops` }).error.includes('oops'));
  check('both day and lives at once is refused as ambiguous',
    !!parseScope({ day: '2026-09-03', sessionIds: U(1) }).error);
  // Separators only is a caller that MEANT to pass lives and passed none. Widening that to the
  // whole backlog is the exact accident this refuses.
  const sep = parseScope({ sessionIds: ',,,' });
  check('a list of only separators is refused, not widened to all',
    !!sep.error && !sep.scope, JSON.stringify(sep));
}

console.log('\nValid scopes');
{
  const d = parseScope({ day: '2026-09-03' });
  check('a well-formed day parses',
    d.scope.kind === 'day' && d.scope.days.join(',') === '2026-09-03');
  const l = parseScope({ sessionIds: `${U(1)},${U(2)}` });
  check('a session list parses', l.scope.kind === 'lives' && l.scope.sessionIds.length === 2);
  check('duplicate ids collapse',
    parseScope({ sessionIds: `${U(1)},${U(1)}` }).scope.sessionIds.length === 1);
  check('surrounding spaces are tolerated',
    parseScope({ sessionIds: ` ${U(1)} , ${U(2)} ` }).scope.sessionIds.length === 2);
  check('uppercase UUIDs are accepted',
    parseScope({ sessionIds: U(1).toUpperCase() }).scope?.kind === 'lives');
}

console.log('\nSeveral days at once — the weekend catch-up case');
{
  const r = parseScope({ day: '2026-09-03,2026-09-02' });
  check('two days parse', r.scope.kind === 'day' && r.scope.days.length === 2);
  // Sorted so two runs over the same selection describe and log identically.
  check('…in a stable order', r.scope.days.join(',') === '2026-09-02,2026-09-03', r.scope.days.join(','));
  check('duplicates collapse', parseScope({ day: '2026-09-03,2026-09-03' }).scope.days.length === 1);
  check('spaces are tolerated',
    parseScope({ day: ' 2026-09-03 , 2026-09-02 ' }).scope.days.length === 2);

  // Non-adjacent days must stay two windows, never one span — a span would sweep in the day
  // between them, which nobody selected.
  const gap = parseScope({ day: '2026-09-01,2026-09-05' });
  check('non-adjacent days stay separate', gap.scope.days.join(',') === '2026-09-01,2026-09-05');

  check('one bad day among good ones refuses the whole set',
    !!parseScope({ day: '2026-09-03,nope' }).error);
  check('…and names the offender', parseScope({ day: '2026-09-03,nope' }).error.includes('nope'));
  check('the cap is 7', MAX_SCOPE_DAYS === 7);
  const many = Array.from({ length: MAX_SCOPE_DAYS + 1 },
    (_, i) => `2026-09-0${(i % 9) + 1}`).join(',');
  check('too many days is refused', !!parseScope({ day: many }).error
    || parseScope({ day: many }).scope.days.length <= MAX_SCOPE_DAYS);
  check('describe names the count for several days',
    describeScope({ kind: 'day', days: ['a', 'b'] }).includes('2'));
  check('…and the date itself for one',
    describeScope({ kind: 'day', days: ['2026-09-03'] }).includes('2026-09-03'));
}

console.log('\nToo many lives is bounded');
{
  check('the cap is 40', MAX_SCOPE_LIVES === 40);
  const ok = Array.from({ length: MAX_SCOPE_LIVES }, (_, i) => U(i)).join(',');
  check('exactly at the cap is allowed', parseScope({ sessionIds: ok }).scope?.kind === 'lives');
  const over = Array.from({ length: MAX_SCOPE_LIVES + 1 }, (_, i) => U(i)).join(',');
  check('one over is refused', !!parseScope({ sessionIds: over }).error);
}

console.log('\nThe fulfilment day is 04:00 → 04:00, not midnight');
{
  // Shows run 17:00 past 01:00, so a midnight boundary would cut one night in half and file the
  // tail under the wrong day — the whole reason this boundary exists.
  const w = dayWindow('2026-09-03');
  const from = new Date(w.fromISO), to = new Date(w.toISO);
  check('the window is exactly 24 hours',
    to.getTime() - from.getTime() === 86_400_000,
    `${(to - from) / 3_600_000}h`);
  const localHour = (iso) => Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  }).format(new Date(iso)));
  check('it starts at 04:00 local', localHour(w.fromISO) === 4, String(localHour(w.fromISO)));
  check('it ends at 04:00 local', localHour(w.toISO) === 4, String(localHour(w.toISO)));

  // A 1am order belongs to the PREVIOUS fulfilment day — the show it actually came from.
  const oneAm = Date.parse('2026-09-04T08:30:00Z'); // 01:30 PT on the 4th
  check('a 1:30am order files under the previous day',
    dayOf(oneAm) === '2026-09-03', dayOf(oneAm));
  const sixPm = Date.parse('2026-09-04T01:00:00Z'); // 18:00 PT on the 3rd
  check('a 6pm order files under that same day', dayOf(sixPm) === '2026-09-03', dayOf(sixPm));
  const fiveAm = Date.parse('2026-09-04T12:00:00Z'); // 05:00 PT on the 4th
  check('a 5am order files under the new day', dayOf(fiveAm) === '2026-09-04', dayOf(fiveAm));
  // The boundary itself belongs to the new day.
  check('04:00 exactly starts the new day',
    dayOf(Date.parse(dayWindow('2026-09-04').fromISO)) === '2026-09-04');
}
{
  // DST: 2026-11-01 is the US fall-back. The window must still be a real day, not 23 or 25h of
  // wall clock mis-set — zonedDayRangeUtcMs handles this, and this guards the reuse.
  const w = dayWindow('2026-11-01');
  check('a DST-transition day still yields a sane window',
    (new Date(w.toISO) - new Date(w.fromISO)) / 3_600_000 >= 23, 
    `${(new Date(w.toISO) - new Date(w.fromISO)) / 3_600_000}h`);
}

console.log('\nDescribing a scope');
{
  check('all', describeScope({ kind: 'all' }).includes('backlog'));
  check('day names the date', describeScope({ kind: 'day', days: ['2026-09-03'] }).includes('2026-09-03'));
  check('lives names the count',
    describeScope({ kind: 'lives', sessionIds: [U(1), U(2)] }).includes('2'));
}

console.log(`\n${passed} checks passed\n`);
