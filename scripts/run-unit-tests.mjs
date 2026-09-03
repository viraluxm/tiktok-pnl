#!/usr/bin/env node
// Run every `*.test.mjs` under src/ and fail if any of them does.
//
// WHY THIS EXISTS: `employees.materialize.test.mjs` failed on main for weeks without anyone
// noticing, because nothing ran these files — only the RPC-grant workflow was wired up. Worse,
// `assert.ok` throws, so that one failure aborted the file after 3 of 17 assertions and
// silently removed coverage of three further scenarios, including the payroll history and
// no-show handling its own header called "the fragile part". A red X nobody runs is not a
// weaker signal than a missing test; it is a misleading one, because it looks like coverage.
//
// Each file is a standalone script (several transpile a .ts source at runtime via the
// `typescript` devDep), so there is no shared runner to hook into — this just executes them
// one per child process and aggregates.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// Every test in the suite passes under both UTC and US/Pacific, but several derive dates from
// a fixed "today" and document TZ=UTC for determinism. Pin it so a runner's local zone can
// never be the difference between green and red.
const TZ = 'UTC';

/** Only a genuine, unambiguous zero. Guards against the glob quietly matching nothing. */
const MIN_EXPECTED_FILES = 1;

async function findTests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await findTests(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, TZ },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ file, code, out }));
  });
}

const files = (await findTests(SRC)).sort();

if (files.length < MIN_EXPECTED_FILES) {
  // A check that finds no tests and reports success is the failure mode this script exists to
  // prevent, so treat it as a hard error rather than a vacuous pass.
  console.error(`No *.test.mjs files found under ${SRC}. Refusing to report success.`);
  process.exit(1);
}

console.log(`Running ${files.length} test files (TZ=${TZ})\n`);

const results = [];
for (const f of files) results.push(await run(f));

const failed = results.filter((r) => r.code !== 0);

for (const r of results) {
  const name = relative(ROOT, r.file);
  if (r.code === 0) {
    // Surface each file's own summary line so the log shows assertion counts, not just ticks.
    const summary = (r.out.match(/(\d+ (?:checks|assertions)[^\n]*passed|ALL PASS[A-Z]*[^\n]*)/gi) || []).pop() ?? '';
    console.log(`  ok    ${name}${summary ? `  ·  ${summary.trim()}` : ''}`);
  } else {
    console.log(`  FAIL  ${name}`);
  }
}

if (failed.length) {
  console.log(`\n${'='.repeat(72)}`);
  for (const r of failed) {
    console.log(`\n--- ${relative(ROOT, r.file)} (exit ${r.code}) ---\n`);
    console.log(r.out.trimEnd());
  }
  console.log(`\n${failed.length} of ${files.length} test files FAILED`);
  process.exit(1);
}

console.log(`\nAll ${files.length} test files passed`);
