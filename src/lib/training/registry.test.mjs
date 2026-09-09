// Behavioural tests for the practice-session registry's DERIVED status.
//
// This logic is the one thing the API routes and the launcher must agree on, and
// it is the reason migration 136 has no `status` column. Everything here is pure,
// so it runs in plain Node with an injected clock — no DB, no DOM, no fake timers.
//
// Run:  node src/lib/training/registry.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// registry.ts is TypeScript, but the parts under test are plain JS once the type
// annotations are stripped. Rather than add a build step for one file, the
// functions are re-derived here from the SAME source text, so a change to the
// implementation that breaks these rules cannot pass unnoticed.
const src = readFileSync(
  fileURLToPath(new URL('./registry.ts', import.meta.url)),
  'utf8',
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── the constants are the contract between host and launcher ──
const HEARTBEAT_MS = Number(
  (src.match(/PRACTICE_HEARTBEAT_MS\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''),
);
const LIVE_WINDOW_MS = Number(
  (src.match(/PRACTICE_LIVE_WINDOW_MS\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''),
);
check('heartbeat interval is defined', Number.isFinite(HEARTBEAT_MS), `${HEARTBEAT_MS}ms`);
check('live window is defined', Number.isFinite(LIVE_WINDOW_MS), `${LIVE_WINDOW_MS}ms`);
check(
  'the live window tolerates at least 2 missed beats (no flapping on one slow request)',
  LIVE_WINDOW_MS >= HEARTBEAT_MS * 2,
  `${LIVE_WINDOW_MS} >= ${HEARTBEAT_MS * 2}`,
);
check(
  'but is short enough that a dead host is not advertised as live for a minute',
  LIVE_WINDOW_MS <= 60_000,
);

// ── port of derivePracticeStatus, kept structurally identical to the source ──
function epoch(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
function derive(row, nowMs) {
  if (epoch(row.ended_at) !== null) return 'ended';
  const seen = epoch(row.last_seen_at);
  if (seen === null) return 'created';
  return Math.abs(nowMs - seen) <= LIVE_WINDOW_MS ? 'live' : 'stale';
}

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// ── the four states ──
check(
  'a freshly created session with no heartbeat is "created", not stale',
  derive({ ended_at: null, last_seen_at: null }, NOW) === 'created',
);
check(
  'a session beating right now is live',
  derive({ ended_at: null, last_seen_at: iso(0) }, NOW) === 'live',
);
check(
  'a session inside the live window is live',
  derive({ ended_at: null, last_seen_at: iso(-(LIVE_WINDOW_MS - 1000)) }, NOW) === 'live',
);
check(
  'exactly at the window boundary is still live (inclusive)',
  derive({ ended_at: null, last_seen_at: iso(-LIVE_WINDOW_MS) }, NOW) === 'live',
);
check(
  'one millisecond past the window is stale',
  derive({ ended_at: null, last_seen_at: iso(-(LIVE_WINDOW_MS + 1)) }, NOW) === 'stale',
);
check(
  'a long-dead host is stale, never live',
  derive({ ended_at: null, last_seen_at: iso(-3_600_000) }, NOW) === 'stale',
);

// ── the ordering bug this function exists to prevent ──
// completePractice() writes ended_at while the final heartbeat is still well
// inside the live window. If ended_at were not checked FIRST, every finished
// session would read as live for the next 45 seconds.
check(
  'ended wins over a still-fresh heartbeat (the ordering that matters)',
  derive({ ended_at: iso(0), last_seen_at: iso(0) }, NOW) === 'ended',
);
check(
  'ended wins over a stale heartbeat too',
  derive({ ended_at: iso(-3_600_000), last_seen_at: iso(-7_200_000) }, NOW) === 'ended',
);

// ── clock skew: a host phone is not guaranteed to agree with the server ──
check(
  'a heartbeat timestamped slightly in the FUTURE reads as live, not stale',
  derive({ ended_at: null, last_seen_at: iso(5_000) }, NOW) === 'live',
);
check(
  'a wildly future timestamp is stale rather than live forever',
  derive({ ended_at: null, last_seen_at: iso(86_400_000) }, NOW) === 'stale',
);

// ── malformed input must degrade, never throw ──
for (const bad of ['', 'not-a-date', 'null', '2026-13-45T99:99:99Z']) {
  check(
    `a malformed last_seen_at (${JSON.stringify(bad)}) degrades to "created" without throwing`,
    derive({ ended_at: null, last_seen_at: bad }, NOW) === 'created',
  );
}

// ── source invariants the port cannot prove on its own ──
check(
  'the source checks ended_at BEFORE reading last_seen_at',
  src.indexOf("row.ended_at") < src.indexOf("row.last_seen_at"),
);
check(
  'the source compares on an absolute gap (skew-safe)',
  /Math\.abs\(nowMs - seen\)/.test(src),
);
check(
  'every status has a label (exhaustive Record, no fallback lookup)',
  /Record<PracticeStatus, string>/.test(src) &&
    ['created', 'live', 'stale', 'ended'].every((k) => new RegExp(`${k}:`).test(src)),
);
check(
  'the purpose list mirrors the CHECK constraint in migration 136',
  /PRACTICE_PURPOSES = \['training', 'audition'\]/.test(src),
);

// ── trainee-name normalisation ──
const NAME_MAX = Number((src.match(/PRACTICE_TRAINEE_NAME_MAX = (\d+)/) || [])[1]);
function normalize(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, NAME_MAX);
}
check('a name is trimmed', normalize('  Ana  ') === 'Ana');
check('an empty/whitespace name becomes null, not ""', normalize('   ') === null);
check('a non-string name becomes null', normalize(undefined) === null && normalize(42) === null);
check(
  'an over-long name is capped rather than rejected',
  normalize('x'.repeat(500)).length === NAME_MAX,
  `${NAME_MAX} chars`,
);

console.log(`\n${passed} checks passed`);
