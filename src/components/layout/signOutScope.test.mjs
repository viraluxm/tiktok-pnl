// Sign-out must stay LOCAL-scoped.
//
// WHY THIS FILE EXISTS: auth-js defaults `signOut()` to { scope: 'global' },
// which deletes every session row for the user on EVERY device. Lensed accounts
// are shared (one station login across the picking machines; the owner account
// across the capture machines and the kiosk), so a bare `signOut()` logs out the
// whole warehouse when one person hands over a device — the "Lensed keeps
// logging everyone out" outage. The regression is a single deleted argument and
// is invisible in review, so pin it here. This lives in a React component with
// no DOM renderer in this repo, so the assertion is source-level, matching
// practiceModeWiring.test.mjs.
//
// Run:  node src/components/layout/signOutScope.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const userMenu = readFileSync(
  fileURLToPath(new URL('./UserMenu.tsx', import.meta.url)),
  'utf8',
);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Strip line comments so the prose above a call site can never satisfy an
// assertion about the call site itself.
const code = userMenu.replace(/^\s*\/\/.*$/gm, '');

const signOutCalls = [...code.matchAll(/\.auth\.signOut\s*\(([^)]*)\)/g)];

check('UserMenu still calls auth.signOut()', signOutCalls.length === 1,
  `found ${signOutCalls.length} call(s)`);

const args = signOutCalls[0][1].trim();

check(
  'signOut() is passed an explicit scope (a bare call defaults to global)',
  args.length > 0,
  'bare signOut() revokes the session on every device sharing this account',
);

check(
  "signOut() scope is 'local'",
  /scope\s*:\s*['"]local['"]/.test(args),
  `args were: ${args || '(none)'}`,
);

check(
  "signOut() is never global- or others-scoped",
  !/['"](global|others)['"]/.test(args),
  `args were: ${args}`,
);

console.log(`\n${passed} checks passed`);
