// Per-host show narrowing. The invariant under test is the one a host bonus rests on:
// filtering by host must partition the show's sales EXACTLY — every sale lands under one
// chip, no sale is counted twice, and no sale disappears.
//
// Run:  node src/lib/shows/hostFilter.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Same runtime-transpile idiom as labor.test.mjs — the suite has no TS loader.
const dir = mkdtempSync(join(tmpdir(), 'hostfilter-'));
const srcPath = fileURLToPath(new URL('./hostFilter.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(dir, 'hostFilter.mjs');
writeFileSync(outFile, outputText);
const {
  UNATTRIBUTED_HOST, filterItemsByHost, hostKey, leadHost, otherHostCount, hostAirTimeMs,
} = await import(pathToFileURL(outFile).href);

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const SAMIE = '60e0bbe6-d941-4d4e-a9b6-5d31ed3b7ec1';
const ISMAEL = '08cd6988-5ea7-45cc-82ae-b8349ac7cce1';

// A show shaped like the real 2026-09-09 one: two hosts, plus an unattributed sale and an
// unbound capture that belongs to neither.
const items = [
  { id: 'a1', host_id: SAMIE, host_unattributed: false },
  { id: 'a2', host_id: SAMIE, host_unattributed: false },
  { id: 'a3', host_id: ISMAEL, host_unattributed: false },
  { id: 'a4', host_id: null, host_unattributed: true },
  { id: 'u1', host_id: null, host_unattributed: true, unbound: true },
];

// ── The partition invariant ──────────────────────────────────────────────────────────────
eq(filterItemsByHost(items, null).length, 5, 'null filter = all hosts, nothing dropped');
eq(filterItemsByHost(items, SAMIE).map((i) => i.id), ['a1', 'a2'], 'Samie gets exactly her sales');
eq(filterItemsByHost(items, ISMAEL).map((i) => i.id), ['a3'], 'Ismael gets exactly his');
eq(filterItemsByHost(items, UNATTRIBUTED_HOST).map((i) => i.id), ['a4', 'u1'], 'unmatched sales are their own bucket');

// Every row appears under exactly one chip — the property that makes the chips sum to the show.
const buckets = [SAMIE, ISMAEL, UNATTRIBUTED_HOST].map((k) => filterItemsByHost(items, k));
const seen = buckets.flat().map((i) => i.id).sort();
eq(seen, ['a1', 'a2', 'a3', 'a4', 'u1'], 'chips partition the show exactly — nothing lost, nothing double-counted');
eq(new Set(seen).size, seen.length, 'no row appears under two hosts');

// A host with no sales must yield an empty array, never the whole show. Getting this wrong
// would silently credit one host with everyone else's work.
eq(filterItemsByHost(items, 'a-host-who-sold-nothing').length, 0, 'unknown host yields nothing, never everything');

// ── Unattributed must never be folded into a host ────────────────────────────────────────
ok(!filterItemsByHost(items, SAMIE).some((i) => i.host_unattributed), 'unattributed stays out of a host bucket');

// A row with no host fields at all (e.g. an older cached payload) is treated as unattributed
// by the server flag only — it must not silently join a host.
eq(filterItemsByHost([{ id: 'x' }], SAMIE).length, 0, 'untagged row never joins a host');

// ── Labelling: longest on air, not last ──────────────────────────────────────────────────
const rollups = [
  { host_id: SAMIE, host_name: 'Samie', minutes: 114.7, auctions: 97 },
  { host_id: ISMAEL, host_name: 'Ismael', minutes: 60.2, auctions: 46 },
  { host_id: null, host_name: 'Unattributed', minutes: 0, auctions: 1 },
];
eq(leadHost(rollups)?.host_name, 'Samie', 'the lead is the longest on air');
// Order must not matter: the rollup arrives air-time-descending today, but the label cannot
// depend on that.
eq(leadHost([...rollups].reverse())?.host_name, 'Samie', 'lead is order-independent');
eq(otherHostCount(rollups), 1, '+N counts the other real hosts');

// Unattributed time is a gap in the log, not a person: it can neither label a show nor be
// counted in the badge, even when it dominates the air time.
const mostlyUnattributed = [
  { host_id: null, host_name: 'Unattributed', minutes: 600, auctions: 5 },
  { host_id: ISMAEL, host_name: 'Ismael', minutes: 12, auctions: 2 },
];
eq(leadHost(mostlyUnattributed)?.host_name, 'Ismael', 'a gap never labels the show');
eq(otherHostCount(mostlyUnattributed), 0, 'a gap is not an extra host');
eq(leadHost([{ host_id: null, host_name: 'Unattributed', minutes: 5, auctions: 1 }]), null, 'all-gap show has no lead');
eq(leadHost([]), null, 'no segments, no lead');
eq(otherHostCount([{ host_id: SAMIE, host_name: 'Samie', minutes: 10, auctions: 1 }]), 0, 'single host shows no badge');

// ── Rates divide by AIR TIME, not show duration ──────────────────────────────────────────
eq(hostAirTimeMs({ minutes: 60 }), 3_600_000, 'air time converts to ms');
eq(hostAirTimeMs(null), null, 'no selection = caller uses the show duration');
// The regression this guards: Ismael hosted 60.2 of a 177-minute show. Dividing his units by
// the show's duration would understate his rate ~3x.
const ismaelHours = hostAirTimeMs({ minutes: 60.2 }) / 3_600_000;
ok(Math.abs(46 / ismaelHours - 45.8) < 0.5, "a host's rate uses their own hours");
ok(46 / ismaelHours > 46 / (177 / 60) * 2, 'air-time rate is materially higher than show-duration rate');

eq(hostKey({ host_id: SAMIE }), SAMIE, 'chip key is the host id');
eq(hostKey({ host_id: null }), UNATTRIBUTED_HOST, 'null host maps to the unattributed chip');

console.log(`  ok    src/lib/shows/hostFilter.test.mjs  ·  ${checks} checks passed`);
