// Per-profile capture binding: which account this browser profile hands the extension.
//
// Exercises the REAL captureBinding.ts, transpiled at runtime. Storage is injected, so no DOM.
//
// THE CASE THAT MATTERS is the one eligibility alone cannot catch: BOTH the owner and an external
// seller are store owners, so both pass the eligibility gate. Only the binding can say that a
// warehouse machine belongs to the owner and must refuse the seller's session — while the
// seller's OWN machine binds to them and works. Asserted in both directions.
//
// The rest is the failure modes: storage that throws, malformed values, and the documented
// fallback when storage is unavailable (relay on eligibility alone rather than invent a new way
// for capture to die mid-show).
//
// Run:  TZ=UTC node src/lib/extension/captureBinding.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'capbind-'));
const srcPath = fileURLToPath(new URL('./captureBinding.ts', import.meta.url));
const out = join(dir, 'captureBinding.mjs');
writeFileSync(out, ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const {
  BINDING_KEY, BIND_NOTICE_MS,
  readBinding, writeBinding, clearBinding, decideRelay, isFreshBind,
} = await import(pathToFileURL(out).href);

const OWNER = 'user-owner';
const SELLER = 'user-seller';
const NOW = 1_760_000_000_000;

// A localStorage double. `mode` lets a test make every accessor throw, or just writes throw.
function fakeStorage(initial = null, mode = 'ok') {
  const map = new Map();
  if (initial !== null) map.set(BINDING_KEY, initial);
  return {
    map,
    getItem(k) { if (mode === 'throw') throw new Error('SecurityError'); return map.get(k) ?? null; },
    setItem(k, v) { if (mode === 'throw' || mode === 'readonly') throw new Error('QuotaExceeded'); map.set(k, v); },
    removeItem(k) { if (mode === 'throw') throw new Error('SecurityError'); map.delete(k); },
  };
}
const bound = (userId, boundAt = NOW - 1000) => JSON.stringify({ userId, boundAt });
const decide = (over = {}) => {
  const storage = over.storage !== undefined ? over.storage : fakeStorage();
  return decideRelay({
    eligible: over.eligible ?? true,
    signedInUserId: over.signedInUserId ?? OWNER,
    read: readBinding(storage),
    nowMs: over.nowMs ?? NOW,
    storage,
  });
};

let passed = 0;
const results = [];
const t = (name, fn) => {
  try { fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

// ── THE CASE ELIGIBILITY CANNOT CATCH ────────────────────────────────────────────────────────
t('a warehouse machine bound to the owner REFUSES an eligible seller', () => {
  const storage = fakeStorage(bound(OWNER));
  const d = decideRelay({ eligible: true, signedInUserId: SELLER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'withhold');
  assert.equal(d.reason, 'bound-to-other', 'the seller IS a store owner — only the binding stops this');
  assert.equal(d.boundUserId, OWNER);
  assert.equal(storage.map.get(BINDING_KEY), bound(OWNER), 'a refused session must not overwrite the binding');
});

t("the seller's OWN machine binds to them and relays", () => {
  const storage = fakeStorage();
  const d = decideRelay({ eligible: true, signedInUserId: SELLER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'relay');
  assert.equal(d.justBound, true);
  assert.equal(d.boundUserId, SELLER);
  assert.deepEqual(JSON.parse(storage.map.get(BINDING_KEY)), { userId: SELLER, boundAt: NOW });
});

t('and thereafter that machine refuses the OWNER, symmetrically', () => {
  const storage = fakeStorage(bound(SELLER));
  const d = decideRelay({ eligible: true, signedInUserId: OWNER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'withhold');
  assert.equal(d.reason, 'bound-to-other');
});

// ── trust on first use, i.e. the zero-touch rollout ──
t('an unbound machine binds to the first ELIGIBLE user and relays', () => {
  const d = decide();
  assert.equal(d.action, 'relay');
  assert.equal(d.justBound, true);
  assert.equal(d.boundUserId, OWNER);
});

t('a matching binding relays without re-binding', () => {
  const storage = fakeStorage(bound(OWNER));
  const d = decideRelay({ eligible: true, signedInUserId: OWNER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'relay');
  assert.equal(d.justBound, false, 'only a FRESH bind is announced');
});

// ── eligibility still comes first ──
t('an INELIGIBLE user neither relays nor claims an unbound machine', () => {
  const storage = fakeStorage();
  const d = decideRelay({ eligible: false, signedInUserId: 'user-admin', read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'withhold');
  assert.equal(d.reason, 'not-eligible');
  assert.equal(storage.map.has(BINDING_KEY), false,
    'otherwise a non-owner could claim a machine merely by signing in on it first');
});

t('an ineligible user cannot dislodge an existing binding either', () => {
  const storage = fakeStorage(bound(OWNER));
  const d = decideRelay({ eligible: false, signedInUserId: SELLER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'withhold');
  assert.equal(d.reason, 'not-eligible');
  assert.equal(storage.map.get(BINDING_KEY), bound(OWNER));
});

// ── storage failures: the documented fallback ──
t('storage that THROWS falls back to eligibility alone, not to withholding', () => {
  const storage = fakeStorage(null, 'throw');
  const read = readBinding(storage);
  assert.equal(read.state, 'unavailable');
  const d = decideRelay({ eligible: true, signedInUserId: OWNER, read, nowMs: NOW, storage });
  assert.equal(d.action, 'relay', 'a new way for capture to die mid-show is worse than the status quo');
  assert.equal(d.justBound, false);
  assert.equal(d.boundUserId, null);
});

t('absent storage (SSR) is unavailable, not unbound', () => {
  assert.equal(readBinding(null).state, 'unavailable');
  assert.equal(readBinding(undefined).state, 'unavailable');
});

t('read-only storage relays but reports it did not bind', () => {
  const storage = fakeStorage(null, 'readonly');
  const d = decideRelay({ eligible: true, signedInUserId: OWNER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'relay');
  assert.equal(d.justBound, false, 'nothing was persisted, so nothing should be announced');
  assert.equal(d.boundUserId, null);
});

// ── malformed values fail toward re-binding, never toward the wrong account ──
t('a malformed binding is treated as unbound, not as a match', () => {
  for (const junk of ['', 'not json', '{}', '{"userId":""}', '{"userId":42}', 'null']) {
    const storage = fakeStorage(junk);
    const read = readBinding(storage);
    assert.equal(read.state, 'unbound', junk);
    const d = decideRelay({ eligible: true, signedInUserId: OWNER, read, nowMs: NOW, storage });
    assert.equal(d.action, 'relay', junk);
    assert.equal(d.justBound, true, junk);
  }
});

t('a binding with a missing/garbage timestamp still binds the user', () => {
  const storage = fakeStorage(JSON.stringify({ userId: OWNER }));
  const read = readBinding(storage);
  assert.equal(read.state, 'bound');
  assert.equal(read.binding.userId, OWNER);
  assert.equal(read.binding.boundAt, 0);
});

t('the stored userId is trimmed', () => {
  const storage = fakeStorage(JSON.stringify({ userId: `  ${OWNER} `, boundAt: NOW }));
  assert.equal(readBinding(storage).binding.userId, OWNER);
});

// ── rebind ──
t('clearing the binding lets the next eligible user take the machine', () => {
  const storage = fakeStorage(bound(OWNER));
  clearBinding(storage);
  assert.equal(readBinding(storage).state, 'unbound');
  const d = decideRelay({ eligible: true, signedInUserId: SELLER, read: readBinding(storage), nowMs: NOW, storage });
  assert.equal(d.action, 'relay');
  assert.equal(d.boundUserId, SELLER, 'this is the Rebind button, and it is a deliberate act');
});

t('clearBinding never throws, even on hostile storage', () => {
  clearBinding(fakeStorage(null, 'throw'));
  clearBinding(null);
});

t('writeBinding reports failure rather than throwing', () => {
  assert.equal(writeBinding(fakeStorage(null, 'readonly'), OWNER, NOW), null);
  assert.equal(writeBinding(null, OWNER, NOW), null);
  assert.deepEqual(writeBinding(fakeStorage(), OWNER, NOW), { userId: OWNER, boundAt: NOW });
});

// ── the fresh-bind notice ──
t('isFreshBind is true only inside the notice window', () => {
  assert.equal(isFreshBind({ userId: OWNER, boundAt: NOW }, NOW), true);
  assert.equal(isFreshBind({ userId: OWNER, boundAt: NOW - BIND_NOTICE_MS + 1 }, NOW), true);
  assert.equal(isFreshBind({ userId: OWNER, boundAt: NOW - BIND_NOTICE_MS }, NOW), false);
  assert.equal(isFreshBind({ userId: OWNER, boundAt: 0 }, NOW), false);
  assert.equal(isFreshBind(null, NOW), false);
});

t('the storage key is versioned', () => {
  assert.match(BINDING_KEY, /\.v\d+$/, 'a shape change must not be readable as a valid binding');
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
