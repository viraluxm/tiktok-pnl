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
const { PRACTICE_VIDEO_CAPTURE, PRACTICE_ROOM_OPTIONS, PRACTICE_MAX_CAPTURE_EDGE } = await import(
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
check('capture ceiling constant is 1280 (720p long edge)', PRACTICE_MAX_CAPTURE_EDGE === 1280);
check(
  'width is capped, not pinned',
  typeof c.width === 'object' && c.width.max === PRACTICE_MAX_CAPTURE_EDGE,
);
check(
  'height is capped, not pinned',
  typeof c.height === 'object' && c.height.max === PRACTICE_MAX_CAPTURE_EDGE,
);
check(
  'BOTH axes are capped at the same value — orientation-agnostic',
  c.width.max === c.height.max,
);
check('frame rate is capped at 30', typeof c.frameRate === 'object' && c.frameRate.max === 30);
check('front camera is still requested', c.facingMode === 'user');

// Portrait safety: pinning an axis (exact/ideal/min) or forcing aspectRatio is
// what would crop/letterbox/rotate a portrait phone stream. None may be present.
for (const axis of ['width', 'height', 'frameRate']) {
  const v = c[axis];
  check(
    `${axis} declares no exact/ideal/min (portrait-safe)`,
    v && v.exact === undefined && v.ideal === undefined && v.min === undefined,
  );
}
check('no aspectRatio constraint (would crop/letterbox portrait)', c.aspectRatio === undefined);
check(
  'no bare numeric width/height (would pin landscape)',
  typeof c.width !== 'number' && typeof c.height !== 'number',
);

// ── The ceiling admits both orientations at 720p but rejects 1080p/4K ──
const admits = (w, h) => w <= c.width.max && h <= c.height.max;
check('admits portrait 720x1280', admits(720, 1280));
check('admits landscape 1280x720', admits(1280, 720));
check('admits portrait 480x640', admits(480, 640));
check('does NOT admit landscape 1080p (1920x1080)', !admits(1920, 1080));
check('does NOT admit portrait 1080p (1080x1920)', !admits(1080, 1920));
check('does NOT admit 4K (3840x2160)', !admits(3840, 2160));

console.log(`\n${passed} checks passed`);
