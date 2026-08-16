// Unit proof for the scan-sink refocus predicate.
//
// Transpiles the REAL src/lib/overlay/scanSink.ts at runtime (import-free, so the transpiled module
// needs nothing resolved from the temp dir) and exercises it directly.
//
// Run: node --test src/lib/overlay/scanSink.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./scanSink.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'scansink-')), 'scanSink.mjs');
writeFileSync(outFile, outputText);
const { shouldRefocusScanSink } = await import(pathToFileURL(outFile).href);

const base = {
  documentHasFocus: true,
  pickerModalOpen: false,
  abandonOpen: false,
  activeElementIsSink: false,
};

test('THE BUG: operator tapped an in-overlay button, focus sits there → refocus', () => {
  // screen/box did not change, so the existing effect never re-fires. Without this, the next
  // scan's Enter re-fires that button ("Grab one" double-counts; "New label" prompts to abandon).
  assert.equal(shouldRefocusScanSink(base), true);
});

test('does NOT refocus when the sink already has focus (no thrash)', () => {
  assert.equal(shouldRefocusScanSink({ ...base, activeElementIsSink: true }), false);
});

test('SUSPENDED while the picker gate is open — the modal owns focus', () => {
  assert.equal(shouldRefocusScanSink({ ...base, pickerModalOpen: true }), false);
  assert.equal(
    shouldRefocusScanSink({ ...base, pickerModalOpen: true, activeElementIsSink: true }),
    false,
  );
});

test('SUSPENDED while the abandon-confirm modal is open', () => {
  assert.equal(shouldRefocusScanSink({ ...base, abandonOpen: true }), false);
});

test('SUSPENDED when the document itself is not focused (tab switch / devtools / lock)', () => {
  assert.equal(shouldRefocusScanSink({ ...base, documentHasFocus: false }), false);
});

test('every suspension wins over the refocus condition', () => {
  for (const suspend of [{ pickerModalOpen: true }, { abandonOpen: true }, { documentHasFocus: false }]) {
    assert.equal(shouldRefocusScanSink({ ...base, ...suspend }), false);
  }
});

test('suspensions combine without surprises', () => {
  assert.equal(
    shouldRefocusScanSink({ documentHasFocus: false, pickerModalOpen: true, abandonOpen: true, activeElementIsSink: true }),
    false,
  );
});
