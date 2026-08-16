// Proof for the room-live binding lockout: the two-room decision, the 5-min end cooldown, the
// 60-min capture backstop, and the no-room passthrough. Transpiles roomLive.ts.
// Run:  TZ=UTC node src/lib/member/roomLive.test.mjs   (also correct under any host TZ)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'rl-'));
const { outputText } = ts.transpileModule(
  readFileSync(new URL('./roomLive.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const p = join(dir, 'roomLive.mjs'); writeFileSync(p, outputText);
const {
  evaluateRoomLock, pickRoomLock, roomLockMessage, roomDisplayName,
  END_COOLDOWN_MS, CAPTURE_BACKSTOP_MS,
} = await import(pathToFileURL(p).href);

let passed = 0;
const check = (n, c, x = '') => { assert.ok(c, `FAIL: ${n} ${x}`); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); passed++; };
const eq2 = (n, got, want) => check(n, got === want, `got ${JSON.stringify(got)}`);

const NOW = Date.parse('2026-08-15T20:00:00.000Z'); // fixed clock; nothing reads Date.now()
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const LOCKED_ROOM = 'room-live-1';
const QUIET_ROOM = 'room-quiet-1';
const lockMap = (...locks) => new Map(locks.map((l) => [l.room, l]));

console.log('\nroom-live lockout — constants');
check('END_COOLDOWN_MS is 5 min', END_COOLDOWN_MS === 5 * MIN, String(END_COOLDOWN_MS));
check('CAPTURE_BACKSTOP_MS is 60 min', CAPTURE_BACKSTOP_MS === 60 * MIN, String(CAPTURE_BACKSTOP_MS));

console.log('\nevaluateRoomLock — primary signal');
{
  // Open session + fresh capture ⇒ locked.
  const l = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], ago(1 * MIN), NOW);
  check('open session + recent capture ⇒ LOCKED', l.locked && l.reason === 'open_session', l.reason);
  check('open-session lock reports the backstop ceiling as clears_at',
    l.clears_at === new Date(NOW - 1 * MIN + CAPTURE_BACKSTOP_MS).toISOString(), l.clears_at);

  // Ended long ago + fresh capture (a NEW show in the same room whose session row is not yet
  // written) ⇒ not locked by this predicate: no open and no in-cooldown session.
  const q = evaluateRoomLock(QUIET_ROOM, [{ id: 's2', ended_at: ago(45 * MIN) }], ago(1 * MIN), NOW);
  check('ended >cooldown ago, capture fresh ⇒ unlocked', !q.locked, String(q.reason));

  // Fully quiet room.
  const q2 = evaluateRoomLock(QUIET_ROOM, [{ id: 's3', ended_at: ago(6 * 60 * MIN) }], ago(6 * 60 * MIN), NOW);
  check('quiet room passes', !q2.locked && q2.reason === null);
}

console.log('\nevaluateRoomLock — 5-min end cooldown');
{
  const justEnded = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: ago(1 * MIN) }], ago(2 * MIN), NOW);
  check('ended 1 min ago ⇒ LOCKED (cooldown)', justEnded.locked && justEnded.reason === 'end_cooldown');
  check('cooldown clears_at = ended_at + 5 min',
    justEnded.clears_at === new Date(NOW - 1 * MIN + END_COOLDOWN_MS).toISOString(), justEnded.clears_at);

  const at4m59 = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: ago(4 * MIN + 59_000) }], ago(5 * MIN), NOW);
  check('ended 4m59s ago ⇒ still LOCKED', at4m59.locked && at4m59.reason === 'end_cooldown');

  const at5m01 = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: ago(5 * MIN + 1000) }], ago(6 * MIN), NOW);
  check('ended 5m01s ago ⇒ released', !at5m01.locked);

  // An open row beats a cooled-down row in the same room.
  const both = evaluateRoomLock(LOCKED_ROOM,
    [{ id: 'old', ended_at: ago(1 * MIN) }, { id: 'open', ended_at: null }], ago(1 * MIN), NOW);
  check('open session wins over end_cooldown', both.reason === 'open_session' && both.session_id === 'open');
}

console.log('\nevaluateRoomLock — 60-min capture backstop (end signal never fired)');
{
  // The crash / sleep / stale-extension case: session never ended, but the room went quiet.
  const stale = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], ago(61 * MIN), NOW);
  check('open session but no capture for 61 min ⇒ RELEASED by backstop', !stale.locked, String(stale.reason));

  const at59 = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], ago(59 * MIN), NOW);
  check('open session, last capture 59 min ago ⇒ still locked', at59.locked && at59.reason === 'open_session');

  const never = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], null, NOW);
  check('open session with NO capture at all ⇒ released (cannot lock forever)', !never.locked);

  const garbage = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], 'not-a-date', NOW);
  check('unparseable capture timestamp ⇒ released, not locked', !garbage.locked);
}

console.log('\nevaluateRoomLock — malformed ended_at is never treated as open');
{
  const bad = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: 'garbage' }], ago(1 * MIN), NOW);
  check('unparseable ended_at ⇒ unlocked (ended-long-ago, not open)', !bad.locked);
}

console.log('\npickRoomLock — two rooms, not one');
{
  const live = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], ago(1 * MIN), NOW);
  const quiet = evaluateRoomLock(QUIET_ROOM, [{ id: 's2', ended_at: ago(9 * 60 * MIN) }], ago(9 * 60 * MIN), NOW);
  const locks = lockMap(live, quiet);

  const byTarget = pickRoomLock(LOCKED_ROOM, QUIET_ROOM, locks);
  check('locked by TARGET session room', byTarget?.which === 'target_session', byTarget?.lock.room);

  // The room-only fallback case: member picked a quiet session, but the order's room is live.
  const byOrder = pickRoomLock(QUIET_ROOM, LOCKED_ROOM, locks);
  check('locked by ORDER room while target is quiet', byOrder?.which === 'order_room', byOrder?.lock.room);

  check('both quiet ⇒ passes', pickRoomLock(QUIET_ROOM, QUIET_ROOM, locks) === null);
  check('both live ⇒ reports the target session first',
    pickRoomLock(LOCKED_ROOM, LOCKED_ROOM, locks)?.which === 'target_session');

  // Order with no resolvable room must not block; target still enforced.
  check('order with NO room + quiet target ⇒ passes', pickRoomLock(QUIET_ROOM, null, locks) === null);
  check('order with NO room + live target ⇒ still refused',
    pickRoomLock(LOCKED_ROOM, null, locks)?.which === 'target_session');
  check('unknown room id is not treated as locked', pickRoomLock('never-seen', null, locks) === null);
}

console.log('\nroomDisplayName — operator-facing identity, never a bare room id');
{
  eq2('handle + store', roomDisplayName('jumbosteals', 'Snore'), 'jumbosteals · Snore');
  eq2('store missing → handle alone', roomDisplayName('jumbosteals', null), 'jumbosteals');
  eq2('store empty/whitespace → handle alone', roomDisplayName('jumbosteals', '   '), 'jumbosteals');
  eq2('handle missing but store present → store alone is NOT used', roomDisplayName(null, 'Snore'), null);
  eq2('neither → null (caller degrades to a generic phrase)', roomDisplayName(null, null), null);
  eq2('undefined inputs do not throw', roomDisplayName(undefined, undefined), null);
}

console.log('\nroomLockMessage — Option C naming, Pacific, named tz, never a fixed offset');
{
  const named = [{ id: 's1', ended_at: null, channel_handle: 'jumbosteals', store_name: 'Snore' }];
  const live = evaluateRoomLock(LOCKED_ROOM, named, ago(1 * MIN), NOW);
  const m = roomLockMessage(live, 'order_room');
  check('names the room as handle · store', m.includes('jumbosteals · Snore'), m);
  check('NEVER leaks the numeric room id to the operator', !m.includes(LOCKED_ROOM), m);
  check('the machine-readable id is still on the lock', live.room === LOCKED_ROOM);
  check("says it is the order's own room", /own room is still live/.test(m), m);
  check('renders a Pacific tz label, not a UTC offset', /\bPDT\b|\bPST\b/.test(m) && !/[+-]\d{2}:\d{2}/.test(m), m);
  // 20:00Z on 2026-08-15 is 13:00 PDT; last capture 1 min earlier renders 12:59 PM.
  check('renders the last capture in Pacific wall time', m.includes('12:59') && m.includes('PM'), m);
  // The backstop clause is the only signal the queue frees itself when live_ended never fires.
  check('keeps the "no later than" backstop clause', /no later than .*(PDT|PST)/.test(m), m);

  // Store missing → degrade to the handle, still never the room id.
  const noStore = evaluateRoomLock(LOCKED_ROOM,
    [{ id: 's1', ended_at: null, channel_handle: 'jumbosteals', store_name: null }], ago(1 * MIN), NOW);
  const m3 = roomLockMessage(noStore, 'target_session');
  check('store missing → names the handle alone', m3.includes('jumbosteals') && !m3.includes('·'), m3);
  check('store missing → still no numeric room id', !m3.includes(LOCKED_ROOM), m3);

  // Nothing resolvable → a generic phrase, never a bare id, never a throw.
  const bare = evaluateRoomLock(LOCKED_ROOM, [{ id: 's1', ended_at: null }], ago(1 * MIN), NOW);
  const m4 = roomLockMessage(bare, 'target_session');
  check('unresolvable → generic phrase, no room id', m4.includes('That room') && !m4.includes(LOCKED_ROOM), m4);
  check('unresolvable → still a complete, readable sentence', /still live\. That room has an open session/.test(m4), m4);

  const cooled = evaluateRoomLock(LOCKED_ROOM,
    [{ id: 's1', ended_at: ago(1 * MIN), channel_handle: 'gummysteals', store_name: 'Snore' }], ago(2 * MIN), NOW);
  const m2 = roomLockMessage(cooled, 'target_session');
  check('cooldown message names the clear time in Pacific', /unlocks at .*(PDT|PST)/.test(m2), m2);
  check('cooldown message says the session you selected', /session you selected/.test(m2), m2);
  check('cooldown message uses handle · store too', m2.includes('gummysteals · Snore'), m2);
}

console.log(`\n${passed} checks passed\n`);
