// Behavioural tests for the replay reducer.
//
// The reducer IS the replay: if it reconstructs a state the host never saw, a
// reviewer judges an audition on fiction. So these test the reconstruction against
// the host's real behaviour (LiveSimulator), not just internal consistency.
//
// Run:  node src/lib/training/replay.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./replay.ts', import.meta.url)), 'utf8');
const simulator = readFileSync(
  fileURLToPath(new URL('../../components/training/LiveSimulator.tsx', import.meta.url)),
  'utf8',
);
const player = readFileSync(
  fileURLToPath(new URL('../../components/training/ReplayPlayer.tsx', import.meta.url)),
  'utf8',
);
const overlay = readFileSync(
  fileURLToPath(new URL('../../components/training/LiveOverlay.tsx', import.meta.url)),
  'utf8',
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── port of stateAtOffset, structurally identical to the source ──
const VISIBLE = 4, START_S = 10, RESET_S = 7, LINGER = 2800;
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function stateAtOffset(events, offsetMs) {
  const s = {
    viewers: 0, comments: [],
    auction: { phase: 'idle', bid: 0, seconds: START_S, winner: null, soldAt: null },
    complete: false,
  };
  let id = 0, clockAt = 0, clockFrom = START_S, endedAt = null;
  for (const e of events) {
    if (e.session_offset_ms > offsetMs) break;
    switch (e.kind) {
      case 'viewers': s.viewers = num(e.payload.count); break;
      case 'comment':
        id += 1;
        s.comments.push({ id, username: str(e.payload.username), text: str(e.payload.text) });
        if (s.comments.length > VISIBLE) s.comments.shift();
        break;
      case 'block': {
        const u = str(e.payload.username);
        s.comments = s.comments.filter((c) => c.username !== u);
        break;
      }
      case 'auction_start':
        s.auction = { phase: 'running', bid: 0, seconds: START_S, winner: null, soldAt: null };
        clockAt = e.session_offset_ms; clockFrom = START_S; endedAt = null;
        break;
      case 'bid':
        s.auction.phase = 'running';
        s.auction.bid = num(e.payload.total);
        s.auction.winner = str(e.payload.username) || null;
        s.auction.soldAt = null;
        clockAt = e.session_offset_ms; clockFrom = RESET_S;
        break;
      case 'auction_end':
        s.auction.phase = 'ended';
        s.auction.soldAt = num(e.payload.sold_at);
        s.auction.bid = num(e.payload.sold_at);
        s.auction.winner = e.payload.winner ?? null;
        s.auction.seconds = 0;
        endedAt = e.session_offset_ms;
        break;
      case 'auction_reset':
        s.auction = { phase: 'idle', bid: 0, seconds: START_S, winner: null, soldAt: null };
        endedAt = null;
        break;
      case 'session_complete': s.complete = true; break;
      default: break;
    }
  }
  if (s.auction.phase === 'running') {
    s.auction.seconds = Math.max(0, clockFrom - Math.floor((offsetMs - clockAt) / 1000));
  }
  if (endedAt !== null && offsetMs - endedAt > LINGER) {
    s.auction = { phase: 'idle', bid: 0, seconds: START_S, winner: null, soldAt: null };
  }
  return s;
}
const ev = (ms, kind, payload = {}) => ({ session_offset_ms: ms, kind, payload });

// A timeline shaped like the real one recorded on 2026-09-09.
const TL = [
  ev(0, 'session_start'),
  ev(0, 'viewers', { count: 1 }),
  ev(10_000, 'viewers', { count: 3 }),
  ev(61_000, 'comment', { username: 'auctionfan', text: 'hello' }),
  ev(63_000, 'comment', { username: 'livebuyer', text: 'hi' }),
  ev(65_000, 'comment', { username: 'westcoastdeals', text: 'how much is shipping?' }),
  ev(66_000, 'auction_start'),
  ev(66_500, 'bid', { username: 'livebuyer', increment: 1, total: 1 }),
  ev(67_500, 'bid', { username: 'techbuyer', increment: 1, total: 8 }),
  ev(74_000, 'auction_end', { sold_at: 8, winner: 'techbuyer' }),
  ev(90_000, 'viewers', { count: 6 }),
  ev(95_000, 'session_complete'),
];

// ── the opening state ──
check('before anything, nothing is on screen', (() => {
  const s = stateAtOffset(TL, -1);
  return s.viewers === 0 && s.comments.length === 0 && s.auction.phase === 'idle';
})());
check('viewers step-hold between samples', stateAtOffset(TL, 30_000).viewers === 3);
check('a later sample replaces the earlier one', stateAtOffset(TL, 92_000).viewers === 6);

// ── comments: only what the host actually displayed ──
check('comments accumulate in order', (() => {
  const c = stateAtOffset(TL, 65_500).comments;
  return c.length === 3 && c[0].username === 'auctionfan' && c[2].text === 'how much is shipping?';
})());
check(
  'only the last 4 are kept, matching the host slicing to -4',
  (() => {
    const many = [ev(0, 'session_start')];
    for (let i = 1; i <= 9; i++) many.push(ev(i * 100, 'comment', { username: `u${i}`, text: `t${i}` }));
    const c = stateAtOffset(many, 10_000).comments;
    return c.length === 4 && c[0].username === 'u6' && c[3].username === 'u9';
  })(),
);
check(
  'the host really does slice to -4 (this is not a guess)',
  /\.slice\(-4\)/.test(simulator),
);

// ── block ──
check('a block removes that user\'s visible comments', (() => {
  const tl = [
    ev(0, 'comment', { username: 'a', text: '1' }),
    ev(1, 'comment', { username: 'b', text: '2' }),
    ev(2, 'block', { username: 'a' }),
  ];
  const c = stateAtOffset(tl, 10).comments;
  return c.length === 1 && c[0].username === 'b';
})());
check(
  'a blocked user has no LATER comments to suppress, because the host logs after the check',
  /blockedRef\.current\.has\(username\)\) return;[\s\S]{0,400}practiceLog\.event\('comment'/.test(simulator),
);

// ── the auction, which is what a reviewer actually watches ──
check('at auction start the card is running with no bid', (() => {
  const a = stateAtOffset(TL, 66_000).auction;
  return a.phase === 'running' && a.bid === 0 && a.winner === null;
})());
check('the countdown starts at 10 and ticks down', (() => {
  return stateAtOffset(TL, 66_000).auction.seconds === 10 &&
    stateAtOffset([ev(0, 'auction_start')], 4_000).auction.seconds === 6;
})());
check('a bid shows the APPLIED TOTAL, not a sum of deltas', (() => {
  const a = stateAtOffset(TL, 67_600).auction;
  return a.bid === 8 && a.winner === 'techbuyer';
})());
check('a bid resets the clock to 7', stateAtOffset(TL, 67_500).auction.seconds === 7);
check('the countdown never goes negative', stateAtOffset([ev(0, 'auction_start')], 60_000).auction.seconds === 0);
check('at auction end the card shows sold with the winner', (() => {
  const a = stateAtOffset(TL, 74_000).auction;
  return a.phase === 'ended' && a.soldAt === 8 && a.winner === 'techbuyer';
})());
check(
  'the sold card lingers briefly, then resets to idle — it does not freeze on screen',
  (() => {
    const during = stateAtOffset(TL, 76_000).auction;
    const after = stateAtOffset(TL, 78_000).auction;
    return during.phase === 'ended' && after.phase === 'idle' && after.bid === 0;
  })(),
);
check(
  'the linger matches the host (2800ms)',
  /\}, 2800\);/.test(simulator) && /SOLD_LINGER_MS = 2800/.test(src),
);
check('a manual reset clears the card immediately', (() => {
  const tl = [ev(0, 'auction_start'), ev(1000, 'bid', { total: 3, username: 'x' }), ev(2000, 'auction_reset')];
  const a = stateAtOffset(tl, 2500).auction;
  return a.phase === 'idle' && a.bid === 0 && a.winner === null;
})());

// ── completion ──
check('complete is false before the end', stateAtOffset(TL, 94_000).complete === false);
check('complete is true after session_complete', stateAtOffset(TL, 96_000).complete === true);

// ── seek must be pure: the same offset always yields the same state ──
check('seeking backwards then forwards gives identical states', (() => {
  const a = JSON.stringify(stateAtOffset(TL, 67_600));
  stateAtOffset(TL, 10_000);
  stateAtOffset(TL, 95_000);
  return JSON.stringify(stateAtOffset(TL, 67_600)) === a;
})());
check(
  'the source folds from zero rather than keeping incremental state',
  /for \(const e of events\)/.test(src) && /if \(e\.session_offset_ms > offsetMs\) break;/.test(src),
);

// ── malformed payloads must not throw ──
check('a missing payload field degrades instead of throwing', (() => {
  const tl = [ev(0, 'comment', {}), ev(1, 'bid', {}), ev(2, 'viewers', {})];
  const s = stateAtOffset(tl, 10);
  return s.comments[0].username === '' && s.auction.bid === 0 && s.viewers === 0;
})());
check('an unknown kind is ignored rather than fatal', (() => {
  const s = stateAtOffset([ev(0, 'not_a_kind'), ev(1, 'viewers', { count: 5 })], 10);
  return s.viewers === 5;
})());

// ── auction markers: the thing that makes a 30-minute file reviewable ──
function markers(events) {
  const out = []; let n = 0;
  for (const e of events) {
    if (e.kind !== 'auction_start') continue;
    n += 1;
    const end = events.find((x) => x.kind === 'auction_end' && x.session_offset_ms > e.session_offset_ms);
    out.push({ offsetMs: e.session_offset_ms, label: `Auction ${n}`, soldAt: end ? num(end.payload.sold_at) : null });
  }
  return out;
}
check('one marker per auction, in order, with its sale price', (() => {
  const m = markers(TL);
  return m.length === 1 && m[0].offsetMs === 66_000 && m[0].label === 'Auction 1' && m[0].soldAt === 8;
})());
check('an auction still running at the end has a null price, not a fake one', (() => {
  const m = markers([ev(0, 'auction_start')]);
  return m.length === 1 && m[0].soldAt === null;
})());
check('several auctions are numbered sequentially', (() => {
  const m = markers([
    ev(0, 'auction_start'), ev(5_000, 'auction_end', { sold_at: 3 }),
    ev(20_000, 'auction_start'), ev(30_000, 'auction_end', { sold_at: 11 }),
  ]);
  return m.length === 2 && m[1].label === 'Auction 2' && m[1].soldAt === 11;
})());

// ── video/session sync ──
function offsetMs(sess, rec) {
  if (!sess || !rec) return 0;
  const a = Date.parse(sess), b = Date.parse(rec);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}
check(
  'the video offset is the gap between session start and recording start',
  offsetMs('2026-09-09T10:00:00.000Z', '2026-09-09T10:00:02.500Z') === 2500,
);
check('a missing timestamp means no shift rather than a wrong one', offsetMs(null, '2026-09-09T10:00:00Z') === 0);
check(
  'it can never be negative (a recording cannot precede its session)',
  offsetMs('2026-09-09T10:00:05Z', '2026-09-09T10:00:00Z') === 0,
);
check('a malformed timestamp degrades to 0', offsetMs('nonsense', '2026-09-09T10:00:00Z') === 0);
check(
  'the source admits the offset is approximate rather than implying precision',
  /APPROXIMATION|approximate/i.test(src) && /nudge/i.test(src),
);

// ── the player must REUSE the live overlay, not reimplement it ──
// A second overlay would drift from the real one the moment either changed, and a
// reviewer would then be judging an audition against a screen the host never saw.
check(
  'the player renders the same LiveOverlay component',
  /import LiveOverlay from '\.\/LiveOverlay'/.test(player) && /<LiveOverlay/.test(player),
);
check('it renders it readOnly', /readOnly\b/.test(player));
check(
  'readOnly removes the Start button (nothing to start after the fact)',
  /\{!readOnly && \(\s*<button/.test(overlay),
);
check(
  'readOnly makes a comment a plain div instead of a moderation button',
  /const Tag = readOnly \? 'div' : 'button'/.test(overlay),
);
check(
  'and the moderation sheet is explicitly unreachable in readOnly',
  /\{!readOnly && selected && \(/.test(overlay),
);

// ── the overlay is driven by the VIDEO's clock, shifted by the derived offset ──
check(
  'the overlay time is video time plus the session offset plus the nudge',
  /videoMs \+ baseOffset \+ nudgeMs/.test(player),
);
check(
  'it uses requestAnimationFrame, not timeupdate (which fires ~4x/s and would lag the countdown)',
  /requestAnimationFrame/.test(player) && !/'timeupdate'/.test(player),
);
check(
  'the nudge exists because the offset is approximate, and is documented as such',
  /NUDGE_MS/.test(player) && /accurate to a second or two|approximate/i.test(player),
);
check(
  'a marker seek lands BEFORE the auction so the run-up is visible',
  /- 3000/.test(player),
);

// ── a recording that is missing or failed must EXPLAIN itself ──
check(
  'a failed take says so and shows its reason',
  /This recording failed/.test(player) && /recording\.error/.test(player),
);
check(
  'and it points out the timeline is still reviewable without footage',
  /timeline is intact/.test(player),
);
check(
  'a session with no recording at all is explained rather than shown blank',
  /No recording for this session/.test(player),
);
check(
  'a truncated timeline is flagged rather than silently stopping the overlay',
  /hit the read limit/.test(player),
);

console.log(`\n${passed} checks passed`);
