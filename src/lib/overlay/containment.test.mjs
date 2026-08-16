// Unit proof for the overlay's background-containment rules.
//
// Transpiles the REAL src/lib/overlay/containment.ts at runtime (import-free) and exercises both
// the pure selection rule and applyBackgroundInert's actual DOM writes — the latter against a
// hand-rolled minimal document rather than jsdom, so no new test infrastructure is needed.
//
// SCOPE REMINDER: this layer is opt-in and dashboard-only (ShippingTab passes containBackground;
// the station page does not). The exempt attribute is kept as defence-in-depth for any caller that
// DOES opt in while portalling siblings to <body>.
//
// Run: node --test src/lib/overlay/containment.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./containment.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'containment-')), 'containment.mjs');
writeFileSync(outFile, outputText);
const { shouldInert, selectInertTargets, applyBackgroundInert, OVERLAY_EXEMPT_ATTR } = await import(
  pathToFileURL(outFile).href
);

class FakeElement {
  constructor(name, attrs = {}) { this.name = name; this.attrs = { ...attrs }; }
  hasAttribute(a) { return Object.prototype.hasOwnProperty.call(this.attrs, a); }
  setAttribute(a, v) { this.attrs[a] = v; }
  removeAttribute(a) { delete this.attrs[a]; }
  get isInert() { return this.hasAttribute('inert'); }
  toString() { return this.name; }
}
function withFakeDom(children, fn) {
  const prevDoc = globalThis.document;
  const prevHtml = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.document = { body: { children } };
  try { return fn(); } finally {
    globalThis.document = prevDoc;
    globalThis.HTMLElement = prevHtml;
  }
}

// ── Selection rule ───────────────────────────────────────────────────────────────────────────

test('inerts the app chrome, never the overlay container', () => {
  const container = new FakeElement('overlay-container');
  const appRoot = new FakeElement('app-root');
  assert.deepEqual(selectInertTargets([appRoot, container], container).map(String), ['app-root']);
  assert.equal(shouldInert(container, container), false);
});

test('data-overlay-exempt siblings are preserved', () => {
  const container = new FakeElement('c');
  const exempt = new FakeElement('dialog', { [OVERLAY_EXEMPT_ATTR]: '' });
  const chrome = new FakeElement('app-root');
  assert.deepEqual(selectInertTargets([chrome, exempt, container], container).map(String), ['app-root']);
  assert.equal(shouldInert(exempt, container), false);
});

test('WITHOUT the attribute a portalled sibling WOULD be inerted', () => {
  // Proves the attribute is load-bearing for any caller that opts into containment.
  assert.equal(shouldInert(new FakeElement('dialog'), new FakeElement('c')), true);
});

test('the exempt attribute name is stable', () => {
  assert.equal(OVERLAY_EXEMPT_ATTR, 'data-overlay-exempt');
});

test('multiple exempt siblings are all preserved; empty body yields nothing', () => {
  const c = new FakeElement('c');
  const children = [new FakeElement('a'), new FakeElement('x1', { [OVERLAY_EXEMPT_ATTR]: '' }), new FakeElement('x2', { [OVERLAY_EXEMPT_ATTR]: '' }), c];
  assert.deepEqual(selectInertTargets(children, c).map(String), ['a']);
  assert.deepEqual(selectInertTargets([], c), []);
});

// ── The DOM writes and the restore path ──────────────────────────────────────────────────────

test('mount inerts the chrome, unmount FULLY restores interactivity', () => {
  const container = new FakeElement('overlay-container');
  const appRoot = new FakeElement('app-root');
  const exempt = new FakeElement('dialog', { [OVERLAY_EXEMPT_ATTR]: '' });

  withFakeDom([appRoot, container, exempt], () => {
    const restore = applyBackgroundInert(container);
    assert.equal(appRoot.isInert, true);
    assert.equal(container.isInert, false);
    assert.equal(exempt.isInert, false);

    restore();
    assert.equal(appRoot.isInert, false, 'background fully restored');
  });
});

test('an element that was ALREADY inert stays inert after restore', () => {
  const container = new FakeElement('c');
  const preInert = new FakeElement('already-inert', { inert: '' });
  const normal = new FakeElement('normal');
  withFakeDom([preInert, normal, container], () => {
    const restore = applyBackgroundInert(container);
    restore();
    assert.equal(preInert.isInert, true, 'left as found');
    assert.equal(normal.isInert, false, 'cleared as found');
  });
});

test('restore is idempotent — unmount cleanup and pagehide can both run', () => {
  const container = new FakeElement('c');
  const appRoot = new FakeElement('app-root');
  withFakeDom([appRoot, container], () => {
    const restore = applyBackgroundInert(container);
    restore();
    appRoot.setAttribute('inert', ''); // something else inerts it afterwards
    restore();                          // must not stomp it
    assert.equal(appRoot.isInert, true);
  });
});

test('non-element body nodes are skipped without throwing', () => {
  const container = new FakeElement('c');
  const stray = { name: 'text-node', hasAttribute: () => false };
  withFakeDom([stray, container], () => {
    applyBackgroundInert(container)();
    assert.equal(Object.prototype.hasOwnProperty.call(stray, 'attrs'), false);
  });
});
