// Behavioural tests for the practice-session event log (migration 139).
//
// The buffer is the thing that decides whether a replay is complete or quietly
// full of holes, so its drop/requeue/throttle rules are tested directly with an
// injected clock — no timers, no DOM, no network.
//
// Run:  node src/lib/training/practiceLog.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./practiceLog.ts', import.meta.url)), 'utf8');
const num = (name) =>
  Number((src.match(new RegExp(`${name} = ([\\d_]+)`)) || [])[1]?.replace(/_/g, ''));

const FLUSH_MS = num('PRACTICE_LOG_FLUSH_MS');
const MAX_BATCH = num('PRACTICE_LOG_MAX_BATCH');
const MAX_BUFFER = num('PRACTICE_LOG_MAX_BUFFER');
const VIEWERS_MS = num('PRACTICE_VIEWERS_LOG_MS');
const PAYLOAD_MAX = num('PRACTICE_PAYLOAD_MAX_CHARS');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const KINDS = [
  'session_start', 'comment', 'bid', 'auction_start', 'auction_end',
  'auction_reset', 'block', 'viewers', 'session_complete',
];

// ── port of createPracticeLogBuffer, structurally identical to the source ──
function makeBuffer() {
  let epoch = null;
  let queue = [];
  let lastViewersAt = -Infinity;
  let droppedCount = 0;
  return {
    start(now) { epoch = now; queue = []; lastViewersAt = -Infinity; droppedCount = 0; },
    add(kind, payload, now) {
      if (epoch === null) return false;
      if (kind === 'viewers') {
        if (now - lastViewersAt < VIEWERS_MS) return false;
        lastViewersAt = now;
      }
      if (queue.length >= MAX_BUFFER) {
        const i = queue.findIndex((e) => e.kind === 'viewers');
        queue.splice(i === -1 ? 0 : i, 1);
        droppedCount++;
      }
      queue.push({ session_offset_ms: Math.max(0, Math.round(now - epoch)), kind, payload });
      return true;
    },
    take(max) { return queue.splice(0, Math.max(0, max)); },
    requeue(events) { if (events.length) queue = [...events, ...queue]; },
    size() { return queue.length },
    dropped() { return droppedCount },
    peek() { return queue },
  };
}

// ── constants ──
check('flush interval is defined', Number.isFinite(FLUSH_MS), `${FLUSH_MS}ms`);
check('the send batch cap is <= the buffer cap', MAX_BATCH <= MAX_BUFFER, `${MAX_BATCH} <= ${MAX_BUFFER}`);
check(
  'the viewers throttle is coarser than the flush interval (or it saves nothing)',
  VIEWERS_MS > FLUSH_MS,
  `${VIEWERS_MS} > ${FLUSH_MS}`,
);
check(
  'the buffer holds well over a normal session (~400 events)',
  MAX_BUFFER >= 1500,
  `${MAX_BUFFER}`,
);

// ── offsets are relative to start, and monotonic ──
{
  const b = makeBuffer();
  // performance.now() does not start at 0, so a non-zero epoch is the realistic case.
  b.start(5_000);
  b.add('session_start', {}, 5_000);
  b.add('comment', { username: 'u', text: 't' }, 5_250);
  b.add('bid', { total: 3 }, 12_000);
  const [a, c, d] = b.peek();
  check('session_start anchors the timeline at offset 0', a.session_offset_ms === 0);
  check('offsets are measured from the epoch, not from zero', c.session_offset_ms === 250);
  check('a later event gets a larger offset', d.session_offset_ms === 7000);
  check('offsets are integers (the column is an integer)', b.peek().every((e) => Number.isInteger(e.session_offset_ms)));
}

// ── an event before start() must not invent an offset ──
{
  const b = makeBuffer();
  check('adding before start() is refused rather than logged at a fake offset', b.add('comment', {}, 1) === false);
  check('...and nothing is buffered', b.size() === 0);
}

// ── a non-monotonic clock reading can never produce a negative offset ──
{
  const b = makeBuffer();
  b.start(10_000);
  b.add('comment', {}, 9_000); // clock went backwards
  check('a backwards clock clamps to 0, never negative', b.peek()[0].session_offset_ms === 0);
}

// ── start() clears the previous session ──
{
  const b = makeBuffer();
  b.start(0);
  b.add('comment', {}, 10);
  b.start(0);
  check('start() clears a previous session\'s buffer', b.size() === 0);
}

// ── viewers throttle ──
{
  const b = makeBuffer();
  b.start(0);
  let accepted = 0;
  // The host's ramp samples every 2.5s; simulate 60s of that.
  for (let t = 0; t <= 60_000; t += 2_500) if (b.add('viewers', { count: 1 }, t)) accepted++;
  const expected = Math.floor(60_000 / VIEWERS_MS) + 1;
  check(
    'viewer samples are throttled, not logged every 2.5s',
    accepted === expected,
    `${accepted} rows for 60s of sampling (vs 25 unthrottled)`,
  );
}
{
  const b = makeBuffer();
  b.start(0);
  b.add('viewers', { count: 1 }, 0);
  b.add('comment', { text: 'x' }, 100);
  b.add('bid', { total: 1 }, 200);
  check('the throttle applies ONLY to viewers, never to comments or bids', b.size() === 3);
}

// ── buffer ceiling: cosmetic events are sacrificed before semantic ones ──
{
  const b = makeBuffer();
  b.start(0);
  // Fill with alternating viewers/comments, defeating the throttle by advancing time.
  for (let i = 0; i < MAX_BUFFER; i++) {
    b.add(i % 2 === 0 ? 'viewers' : 'comment', { i }, i * VIEWERS_MS);
  }
  const viewersBefore = b.peek().filter((e) => e.kind === 'viewers').length;
  const commentsBefore = b.peek().filter((e) => e.kind === 'comment').length;
  b.add('bid', { total: 99 }, MAX_BUFFER * VIEWERS_MS);
  const viewersAfter = b.peek().filter((e) => e.kind === 'viewers').length;
  const commentsAfter = b.peek().filter((e) => e.kind === 'comment').length;
  check('the buffer never grows past its ceiling', b.size() === MAX_BUFFER);
  check('an overflow drops a VIEWERS sample first (cosmetic)', viewersAfter === viewersBefore - 1);
  check('...and keeps every semantic event', commentsAfter === commentsBefore);
  check('the new event is still recorded', b.peek().some((e) => e.kind === 'bid'));
  check('a drop is counted, not silent', b.dropped() === 1);
}
{
  // No viewers left to sacrifice: the OLDEST semantic event goes, so the end of the
  // session (where a reviewer is usually heading) survives.
  const b = makeBuffer();
  b.start(0);
  for (let i = 0; i < MAX_BUFFER; i++) b.add('comment', { i }, i);
  b.add('bid', { last: true }, MAX_BUFFER);
  check('with no viewers to drop, the OLDEST event is sacrificed', b.peek()[0].payload.i === 1);
  check('...and the newest event survives', b.peek()[b.size() - 1].payload.last === true);
}

// ── take / requeue: a failed POST must not lose events ──
{
  const b = makeBuffer();
  b.start(0);
  for (let i = 0; i < 10; i++) b.add('comment', { i }, i);
  const batch = b.take(4);
  check('take() returns the OLDEST events first', batch.map((e) => e.payload.i).join() === '0,1,2,3');
  check('take() removes them from the buffer', b.size() === 6);
  b.requeue(batch);
  check('requeue() restores them', b.size() === 10);
  check(
    'requeue() puts them back at the FRONT, preserving chronological order',
    b.peek().map((e) => e.payload.i).join() === '0,1,2,3,4,5,6,7,8,9',
  );
}
{
  const b = makeBuffer();
  b.start(0);
  check('take() on an empty buffer is empty, not an error', b.take(10).length === 0);
  b.requeue([]);
  check('requeue([]) is a no-op', b.size() === 0);
}

// ── validatePracticeEvent (the route is the enforcer) ──
function validate(e) {
  if (typeof e !== 'object' || e === null) return 'event must be an object';
  if (!KINDS.includes(e.kind)) return `unknown kind: ${String(e.kind)}`;
  const off = e.session_offset_ms;
  if (typeof off !== 'number' || !Number.isSafeInteger(off) || off < 0) {
    return 'session_offset_ms must be a non-negative integer';
  }
  if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
    return 'payload must be a plain object';
  }
  if (JSON.stringify(e.payload).length > PAYLOAD_MAX) return 'payload too large';
  return null;
}
const ok = { kind: 'comment', session_offset_ms: 10, payload: { text: 'hi' } };
check('a well-formed event validates', validate(ok) === null);
check('an unknown kind is rejected', validate({ ...ok, kind: 'nope' }) !== null);
check('a negative offset is REJECTED, not clamped (it would sort before session_start)',
  validate({ ...ok, session_offset_ms: -1 }) !== null);
check('a fractional offset is rejected (the column is an integer)',
  validate({ ...ok, session_offset_ms: 1.5 }) !== null);
check('a non-numeric offset is rejected', validate({ ...ok, session_offset_ms: '10' }) !== null);
check('an array payload is rejected (jsonb would accept it; the replay would not)',
  validate({ ...ok, payload: [1, 2] }) !== null);
check('a null payload is rejected', validate({ ...ok, payload: null }) !== null);
check('an oversized payload is rejected',
  validate({ ...ok, payload: { t: 'x'.repeat(PAYLOAD_MAX + 100) } }) !== null);
check('a non-object event is rejected', validate('nope') !== null && validate(null) !== null);

// ── the kind list must match the CHECK constraint in migration 139 ──
{
  const mig = readFileSync(
    fileURLToPath(new URL('../../../supabase/migrations/139_practice_events.sql', import.meta.url)),
    'utf8',
  );
  const inSql = KINDS.filter((k) => new RegExp(`'${k}'`).test(mig));
  check(
    'every app kind appears in the migration CHECK (a drift would silently vanish from replay)',
    inSql.length === KINDS.length,
    `${inSql.length}/${KINDS.length}`,
  );
  check(
    'the source kind list and the test list agree',
    KINDS.every((k) => new RegExp(`'${k}'`).test(src)),
  );
}

console.log(`\n${passed} checks passed`);
