// WHERE THE CAPTURE RELAY IS MOUNTED, AND WHAT GATES IT.
//
// This file replaces (seller)/layout.wiring.test.mjs, and the reason it changed is the point.
//
// That test asserted the (seller) group mounts NO relay. The safety argument was: a seller owns a
// store, so the eligibility check passes them, and a seller signing into lensed.io in the Chrome
// profile running OUR capture extension would replace its JWT with theirs — captures writing under
// their user_id, accepted by own-row RLS, invisible to us. Keeping the relay out of their tree made
// that impossible.
//
// It also made the seller's OWN extension impossible, which is how their sales deplete our shared
// stock. Withholding the relay did not remove the hazard; it moved it, and broke depletion doing so.
//
// The real question was never "which route group are you in" — it is "which account does THIS
// machine capture as". That is the capture binding (@/lib/extension/captureBinding), and with it
// the relay can be mounted in both trees: the seller's machine binds to them, a warehouse machine
// stays bound to the owner and refuses them, visibly, in both directions.
//
// So the invariant this file pins is no longer "absent from one tree". It is:
//   • exactly ONE component mounts the hook, so the gates and the banner cannot diverge
//   • nothing anywhere else talks to the extension directly
//   • the seller group still carries none of the OWNER's surface
//
// Run:  node src/components/extension/relayMounting.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', '..');
const read = (rel) => readFileSync(join(srcDir, rel), 'utf8');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

/** Source with comments stripped — prose that NAMES a thing must not satisfy a check about it. */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');

function walk(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(full)); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}
const allSource = walk(srcDir);

// ── exactly one mount point ──
const hookCallers = allSource.filter((f) => {
  if (f.endsWith(join('hooks', 'useExtensionAuth.ts'))) return false;
  return /useExtensionAuth\(\)/.test(strip(readFileSync(f, 'utf8')));
});
check(
  'exactly one component calls useExtensionAuth',
  hookCallers.length === 1 && hookCallers[0].endsWith('CaptureRelay.tsx'),
  hookCallers.map((f) => f.slice(srcDir.length)).join(', ') || 'none',
);

// ── nothing else talks to the extension ──
const directTalkers = allSource.filter((f) => {
  if (f.endsWith(join('hooks', 'useExtensionAuth.ts'))) return false;
  const src = strip(readFileSync(f, 'utf8'));
  return /chrome\.runtime\.sendMessage\(/.test(src) || /LENSED_AUTH/.test(src);
});
check(
  'only the hook speaks to the extension directly',
  directTalkers.length === 0,
  directTalkers.map((f) => f.slice(srcDir.length)).join(', '),
);

// ── the component is the thing carrying the gates ──
const relay = strip(read(join('components', 'extension', 'CaptureRelay.tsx')));
check('CaptureRelay mounts the hook', /useExtensionAuth\(\)/.test(relay));
check('it surfaces a machine bound to someone else', /bound-to-other/.test(relay),
  'a console line is not a UI; the person at the keyboard has to be told');
check('it offers the rebind', /rebind/.test(relay));
check(
  "it does NOT nag about 'not-eligible'",
  !/not-eligible/.test(relay),
  'that is the normal state for every non-owner on every page — a banner for it is noise',
);

// ── both trees mount it ──
const appLayout = strip(read(join('app', '(app)', 'layout.tsx')));
const sellerLayout = strip(read(join('app', '(seller)', 'layout.tsx')));
check('(app) mounts CaptureRelay', /<CaptureRelay \/>/.test(appLayout));
check('(seller) mounts CaptureRelay', /<CaptureRelay \/>/.test(sellerLayout),
  'the seller runs the extension too; an unrelayed extension never captures, so nothing depletes');

// ── and the (station) tree still does not, because those roles own no data ──
const stationLayout = strip(read(join('app', '(station)', 'layout.tsx')));
check(
  '(station) still mounts no relay',
  !/CaptureRelay/.test(stationLayout) && !/useExtensionAuth/.test(stationLayout),
  'station/member accounts own no data — a relayed session there would capture as nobody useful',
);
const refresher = strip(read(join('components', 'station', 'StationSessionRefresher.tsx')));
check('the session refresher does not relay either', !/useExtensionAuth|sendToExtension/.test(refresher));

// ── the seller group still carries none of the owner's surface ──
const sellerFiles = walk(join(srcDir, 'app', '(seller)'));
check('the (seller) group has files to check', sellerFiles.length >= 4, `${sellerFiles.length} files`);
for (const f of sellerFiles) {
  const src = strip(readFileSync(f, 'utf8'));
  const rel = f.slice(join(srcDir, 'app', '(seller)').length);
  check(`${rel} mounts no ChatWidget`, !/ChatWidget/.test(src));
  check(`${rel} links to no owner route`, !/href="\/(dashboard|admin|entries|products|account)/.test(src));
}
check('the (seller) layout is a server component', !/^'use client'/m.test(read(join('app', '(seller)', 'layout.tsx'))));
check('it keeps the session alive', /StationSessionRefresher/.test(sellerLayout),
  'the middleware validates but no longer rotates tokens');

console.log(`\n${passed} mounting checks passed`);
