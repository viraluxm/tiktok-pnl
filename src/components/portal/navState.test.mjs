// navState: the portal's URL state. Round-trips, defaults, legacy ?view=team, malformed dates.
// Run:  TZ=UTC node src/components/portal/navState.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'navstate-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return pathToFileURL(p).href; };
function transpile(rel, out, rw = {}) {
  const sp = fileURLToPath(new URL(rel, import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(sp, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  for (const [f, t] of Object.entries(rw)) outputText = outputText.split(f).join(t);
  return write(out, outputText);
}
const timezone = transpile('../../lib/schedule/timezone.ts', 'timezone.mjs');
const employees = transpile('../../lib/employees.ts', 'employees.mjs');
const hours = transpile('../../lib/schedule/hours.ts', 'hours.mjs', { "'@/lib/employees'": `'${employees}'`, "'./timezone'": `'${timezone}'` });
const model = transpile('../../lib/schedule/portalModel.ts', 'portalModel.mjs', { "'./timezone'": `'${timezone}'`, "'./hours'": `'${hours}'` });
const N = await import(transpile('./navState.ts', 'navState.mjs', { "'@/lib/schedule/portalModel'": `'${model}'` }));

let passed = 0;
const eq = (n, a, b) => { assert.deepStrictEqual(a, b, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };
const p = (q) => N.parseNav(new URLSearchParams(q));

eq('empty → Home, My Shifts, this week', p(''), { tab: 'home', seg: 'mine', week: null, day: null, period: null });
eq('schedule/team', p('tab=schedule&seg=team'), { tab: 'schedule', seg: 'team', week: null, day: null, period: null });
eq('week snaps to its Monday', p('tab=schedule&week=2026-09-10'), { tab: 'schedule', seg: 'mine', week: '2026-09-07', day: null, period: null });
eq('day kept', p('day=2026-09-10'), { tab: 'home', seg: 'mine', week: null, day: '2026-09-10', period: null });
eq('bogus tab/seg fall back', p('tab=admin&seg=payroll'), { tab: 'home', seg: 'mine', week: null, day: null, period: null });
eq('rolled-over date ignored', p('week=2026-02-31&day=2026-13-01'), { tab: 'home', seg: 'mine', week: null, day: null, period: null });
eq('legacy ?view=team lands on Schedule → Team', p('view=team'), { tab: 'schedule', seg: 'team', week: null, day: null, period: null });
eq('legacy ?week from the old portal still works', p('week=2026-09-09&view=team'), { tab: 'schedule', seg: 'team', week: '2026-09-07', day: null, period: null });
eq('hours tab', p('tab=hours'), { tab: 'hours', seg: 'mine', week: null, day: null, period: null });

eq('format: defaults produce an empty string (no ?)', N.formatNav({ tab: 'home', seg: 'mine', week: null, day: null, period: null }), '');
eq('format: schedule/open with week+day', N.formatNav({ tab: 'schedule', seg: 'open', week: '2026-09-07', day: '2026-09-10', period: null }), '?tab=schedule&seg=open&week=2026-09-07&day=2026-09-10');
eq('format: seg is dropped outside Schedule', N.formatNav({ tab: 'requests', seg: 'team', week: null, day: null, period: null }), '?tab=requests');
const rt = { tab: 'schedule', seg: 'team', week: '2026-09-14', day: '2026-09-16', period: null };
eq('round-trip parse(format(x)) === x', p(N.formatNav(rt).slice(1)), rt);

// PAY PERIOD. A past period is a URL, so a back-swipe out of one returns to the Hours list rather
// than leaving the app. It is NOT snapped to a Monday — a period start is a boundary of the
// biweekly cycle, and the server is the one that refuses a date that is not one.
eq('period is kept verbatim on Hours', p('tab=hours&period=2026-08-24'), { tab: 'hours', seg: 'mine', week: null, day: null, period: '2026-08-24' });
eq('a malformed period is dropped', p('tab=hours&period=2026-13-99'), { tab: 'hours', seg: 'mine', week: null, day: null, period: null });
eq('format: period is written only on Hours', N.formatNav({ tab: 'hours', seg: 'mine', week: null, day: null, period: '2026-08-24' }), '?tab=hours&period=2026-08-24');
eq('format: period is dropped off Hours', N.formatNav({ tab: 'home', seg: 'mine', week: null, day: null, period: '2026-08-24' }), '');
const rtp = { tab: 'hours', seg: 'mine', week: null, day: null, period: '2026-08-24' };
eq('round-trip parse(format(period)) === period', p(N.formatNav(rtp).slice(1)), rtp);

console.log(`\n${passed} checks passed`);
