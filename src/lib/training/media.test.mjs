// Unit proof for the Practice Mode media policy (P0-3: bandwidth + portrait-safe
// capture ceiling). Transpiles the real media.ts via the repo's `typescript`
// devDep — same pattern as session.test.mjs — so these assert the SHIPPED values,
// not a copy. media.ts is intentionally dependency-free, so it imports cleanly in
// plain Node.
//
// Run:  node src/lib/training/media.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./media.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tmedia-')), 'media.mjs');
writeFileSync(outFile, outputText);
const { PRACTICE_VIDEO_CAPTURE, PRACTICE_ROOM_OPTIONS, PRACTICE_VIDEO_ENCODING } = await import(
  pathToFileURL(outFile).href
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── LiveKit bandwidth options: adaptive stream + dynacast must both be ON ──
check('adaptiveStream is enabled', PRACTICE_ROOM_OPTIONS.adaptiveStream === true);
check('dynacast is enabled', PRACTICE_ROOM_OPTIONS.dynacast === true);
check(
  'both are enabled together (they only pay off as a pair)',
  PRACTICE_ROOM_OPTIONS.adaptiveStream === true && PRACTICE_ROOM_OPTIONS.dynacast === true,
);

// ── Capture ceiling: <=720p-equivalent, and portrait-safe ──
const c = PRACTICE_VIDEO_CAPTURE;

// ── The capture constraints must contain NOTHING that livekit-client's
// unwrapConstraint() can choke on.
//
// #208 capped capture with `{ max: 1280 }` ranges. That broke publishTrack in
// every browser for five days: its default degradation-preference reads
//     track.constraints.height && unwrapConstraint(track.constraints.height) >= 1080
// and unwrapConstraint accepts only a bare number, an array, `{exact}` or
// `{ideal}` — a `{max}` range hits its throw. The capture ceiling has therefore
// been replaced by an UPLOAD ceiling (PRACTICE_VIDEO_ENCODING), which is the lever
// that actually saves bandwidth and involves no constraint parsing. ──
function unwrapConstraint(constraint) {
  if (typeof constraint === 'string' || typeof constraint === 'number') return constraint;
  if (Array.isArray(constraint)) return constraint[0];
  if (constraint.exact !== undefined) {
    return Array.isArray(constraint.exact) ? constraint.exact[0] : constraint.exact;
  }
  if (constraint.ideal !== undefined) {
    return Array.isArray(constraint.ideal) ? constraint.ideal[0] : constraint.ideal;
  }
  throw Error('could not unwrap constraint');
}

check('capture requests the front camera', c.facingMode === 'user');
check(
  'capture declares NO width/height/frameRate (so the throwing branch is never reached)',
  c.width === undefined && c.height === undefined && c.frameRate === undefined,
);
check(
  'every declared capture constraint survives unwrapConstraint',
  Object.values(c).every((v) => {
    try { unwrapConstraint(v); return true; } catch { return false; }
  }),
);
check(
  'a {max}-only range is what would break it (the regression being guarded)',
  (() => { try { unwrapConstraint({ max: 1280 }); return false; } catch { return true; } })(),
);
check('no aspectRatio is pinned (portrait hosts keep their framing)', c.aspectRatio === undefined);

// ── The bandwidth intent from #208 must survive, at the publish layer ──
check(
  'an upload ceiling is defined',
  typeof PRACTICE_VIDEO_ENCODING.maxBitrate === 'number' &&
    PRACTICE_VIDEO_ENCODING.maxBitrate > 0,
  `${PRACTICE_VIDEO_ENCODING.maxBitrate / 1000} kbps`,
);
check(
  'it is meaningfully below what LiveKit would default to for 720p+ (~3 Mbps)',
  PRACTICE_VIDEO_ENCODING.maxBitrate <= 2_000_000,
);
check('the frame rate is still capped at 30', PRACTICE_VIDEO_ENCODING.maxFramerate === 30);
check(
  'ten concurrent hosts stay within a sane uplink budget',
  (PRACTICE_VIDEO_ENCODING.maxBitrate * 10) / 1e6 <= 15,
  `${(PRACTICE_VIDEO_ENCODING.maxBitrate * 10) / 1e6} Mbps for 10 hosts`,
);

// ── #208's other two bandwidth measures are untouched ──
check('adaptiveStream is on (subscriber half)', PRACTICE_ROOM_OPTIONS.adaptiveStream === true);
check('dynacast is on (publisher half)', PRACTICE_ROOM_OPTIONS.dynacast === true);

console.log(`\n${passed} checks passed`);
