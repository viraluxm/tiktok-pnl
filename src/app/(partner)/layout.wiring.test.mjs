// THE PARTNER GROUP MUST NEVER MOUNT THE CAPTURE RELAY.
//
// This is the whole reason the (partner) route group exists, and it is a property of a React tree
// that this repo has no renderer for — so it is asserted on the real source, the same way
// practiceModeWiring.test.mjs pins its component invariants.
//
// THE FAILURE IT CATCHES: useExtensionAuth hands the signed-in session to the capture extension,
// which writes capture_events under that token's user_id. A partner legitimately owns a store, so
// the relay's eligibility guard PASSES them. If a partner page ever ended up under a layout that
// mounts the relay — moved into (app), or someone adding the hook here "for consistency" — a
// partner signing into lensed.io on a warehouse capture machine would silently take over capture:
// accepted by own-row RLS, invisible to the owner, no error anywhere. That is the 2026-07-22 shape
// (383 orders orphaned).
//
// It cannot be caught by using the app: everything looks fine until the wrong rows appear under
// the wrong account days later. So it is pinned here.
//
// Run:  node src/app/(partner)/layout.wiring.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── every file in the group, not just the layout ──
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
const groupFiles = walk(here).filter((f) => !f.endsWith('.test.mjs'));
check('the (partner) group has files to check', groupFiles.length >= 2, `${groupFiles.length} files`);

for (const f of groupFiles) {
  const src = readFileSync(f, 'utf8');
  const rel = f.slice(here.length);
  check(`${rel} does not import useExtensionAuth`, !/useExtensionAuth/.test(src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  check(`${rel} does not call sendToExtension`, !/sendToExtension\(/.test(src));
  check(`${rel} does not post a LENSED_AUTH message`, !/LENSED_AUTH/.test(src));
}

// ── the layout's own shape ──
// Comments stripped: the layout's own prose NAMES the things it must not mount (that is the point
// of the comment), so a check run against the raw file would pass on the explanation instead of
// the code.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
const layout = stripComments(read('./layout.tsx'));
check('the layout keeps the session alive (StationSessionRefresher)', /StationSessionRefresher/.test(layout),
  'without it the token lapses ~60min after sign-in and bounces the seller to /login');
check('the layout mounts no ChatWidget', !/ChatWidget/.test(layout),
  'the assistant answers owner-scoped payroll and P&L questions');
check('the layout is a server component (no "use client")', !/^'use client'/m.test(layout));

// ── and the refresher it depends on must not relay either ──
const refresher = readFileSync(join(here, '../../components/station/StationSessionRefresher.tsx'), 'utf8');
const refresherCode = refresher
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('StationSessionRefresher itself does not relay', !/useExtensionAuth|sendToExtension/.test(refresherCode));

// ── the (app) layout still DOES mount it: proves this test is comparing against something real ──
const appLayout = readFileSync(join(here, '../(app)/layout.tsx'), 'utf8');
check('(app) still mounts the relay (control case)', /useExtensionAuth\(\)/.test(appLayout),
  'if this ever fails, the relay moved and this test is no longer proving anything');

console.log(`\n${passed} wiring checks passed`);
