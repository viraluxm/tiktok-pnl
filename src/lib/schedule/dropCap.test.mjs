// Proof for the drop-cap gate that release.ts now enforces. computeDrops is the pure input to that
// decision, so transpile drops.ts alone and assert the boundary release.ts keys on (drops >= CAP).
//   Run:  node src/lib/schedule/dropCap.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict'; import ts from 'typescript';

const src = readFileSync(fileURLToPath(new URL('./drops.ts', import.meta.url)), 'utf8');
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const out = join(mkdtempSync(join(tmpdir(), 'dc-')), 'dc.mjs'); writeFileSync(out, outputText);
const { computeDrops, DROP_CAP } = await import(pathToFileURL(out).href);

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };
const rel = (d) => ({ event_type: 'released', shift_date: d });
const clm = (d) => ({ event_type: 'claimed', shift_date: d });
const exc = (d) => ({ event_type: 'excused', shift_date: d });
// release.ts refuses when this is true.
const blocked = (events) => computeDrops(events).drops >= DROP_CAP;

console.log('\nthe gate release.ts keys on');
check('no history → allowed', !blocked([]));
check('one drop → still allowed', !blocked([rel('2026-09-10')]));
check('at the cap → REFUSED (routed to a manager)', blocked([rel('2026-09-10'), rel('2026-09-11')]));
check('past the cap → refused', blocked([rel('2026-09-10'), rel('2026-09-11'), rel('2026-09-12')]));

console.log('\nnetting — finding your own cover costs nothing');
check('release + claim in the same period nets to zero',
  !blocked([rel('2026-09-10'), clm('2026-09-14')]));
check('two releases + two claims still allowed',
  !blocked([rel('2026-09-10'), rel('2026-09-11'), clm('2026-09-14'), clm('2026-09-15')]));
check('two releases + ONE claim is at the cap boundary but under it',
  !blocked([rel('2026-09-10'), rel('2026-09-11'), clm('2026-09-14')]));
check('three releases + one claim → refused',
  blocked([rel('2026-09-10'), rel('2026-09-11'), rel('2026-09-12'), clm('2026-09-14')]));

console.log('\nan excused release is forgiven, so it cannot lock someone out');
check('excusing one of two releases reopens the cap',
  !blocked([rel('2026-09-10'), rel('2026-09-11'), exc('2026-09-10')]));
check('excused is keyed to the SAME shift_date, not any release',
  blocked([rel('2026-09-10'), rel('2026-09-11'), exc('2026-09-30')]));
check('drops never go negative on more claims than releases',
  computeDrops([clm('2026-09-14'), clm('2026-09-15')]).drops === 0);

console.log('\nrelease.ts still implements this gate');
{
  const rsrc = readFileSync(fileURLToPath(new URL('./release.ts', import.meta.url)), 'utf8');
  check('it compares against DROP_CAP', /drops\.drops >= DROP_CAP/.test(rsrc));
  check('it throws DROP_CAP_REACHED rather than silently allowing', /DROP_CAP_REACHED/.test(rsrc));
  check('it requires a reason', /REASON_REQUIRED/.test(rsrc));
  check('the reason is persisted on the event', /note: trimmedReason/.test(rsrc));
}

console.log(`\n${passed} checks passed\n`);
