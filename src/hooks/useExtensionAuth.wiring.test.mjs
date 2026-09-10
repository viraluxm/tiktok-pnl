// Wiring invariants for the capture-extension relay guard.
//
// WHY THIS FILE EXISTS: the guard's decision logic is pure and covered in
// src/lib/extension/relayEligibility.test.mjs, but the thing that actually protects captures is
// WHERE that decision sits inside a React hook — and this repo has no DOM renderer. The failure
// this pins is a plausible one: someone adds a new push path (a visibility handler, a retry, a
// second call site) and reaches for sendToExtension directly, restoring the unguarded relay
// without touching anything the pure tests can see.
//
// So: every token that leaves this file must leave through relay(), and relay() must consult
// eligibility first. Asserted on the real source.
//
// Run:  node src/hooks/useExtensionAuth.wiring.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const hook = read('./useExtensionAuth.ts');
const route = read('../app/api/ext/relay-eligible/route.ts');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Strip the file's comments so prose describing the guard can never satisfy a check about it.
const code = hook
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

// ── the single exit ──
// The declaration is `function sendToExtension(` — exclude it and count real call sites.
const sendCalls = [...code.matchAll(/(?<!function )sendToExtension\(/g)].length;
check(
  'sendToExtension is called exactly once in the file',
  sendCalls === 1,
  `${sendCalls} call site(s) — a second one is an unguarded relay`,
);
check(
  'that call lives inside relay()',
  /const relay = async \([\s\S]*?sendToExtension\(/.test(code),
);

// ── the guard, before the token ──
const relayBody = (code.match(/const relay = async \([\s\S]*?\n    \};/) || [])[0] ?? '';
check('relay() resolves eligibility for the session user', /eligibilityFor\(session\.user\.id\)/.test(relayBody));
check('relay() returns early when the verdict is not a yes', /if \(!mayRelay\(/.test(relayBody));
check(
  'the withheld branch returns BEFORE lastToken is written',
  relayBody.indexOf('return;') < relayBody.indexOf('lastToken.current ='),
  'an ineligible session must not seed the pull cache',
);
check('withholding is logged as an error, not swallowed', /console\.error\(/.test(relayBody));

// ── the pull responder ──
const onMessage = (code.match(/const onMessage = async \([\s\S]*?\n    \};/) || [])[0] ?? '';
check('the pull responder checks eligibility too', /if \(!mayRelay\(verdict\)\)/.test(onMessage));
check(
  'it replies null and stops, before any getSession()',
  onMessage.indexOf('mayRelay(verdict)') < onMessage.indexOf('supabase.auth.getSession()'),
);
check(
  'a verdict still in flight is awaited, not answered as a refusal',
  /verdict === 'unknown' && pending\.current/.test(onMessage),
  'else a 401 during page load strands the owner in a reconnect state',
);

// ── identity changes ──
check(
  'eligibility is cached per user id, not globally',
  /cached\.userId === userId/.test(code),
  'a second account on the same page must be re-checked',
);
check(
  'sign-out clears the cached token and the verdict',
  /lastToken\.current = null;[\s\S]{0,200}eligibility\.current = \{ userId: null, value: 'unknown' \}/.test(code),
);

// ── the server side of the question ──
check("the endpoint asks store_members for the caller's OWNED stores", /\.from\('store_members'\)/.test(route));
check('scoped to the caller, written into the query', /\.eq\('user_id', user\.id\)/.test(route));
check("and to role='owner'", /\.eq\('role', 'owner'\)/.test(route));
check('an unresolved lookup is a 500, not a default yes', /status: 500/.test(route) && !/eligible: true/.test(route.split('if (error)')[1] ?? ''));

console.log(`\n${passed} wiring checks passed`);
