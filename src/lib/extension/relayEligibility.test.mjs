// Relay eligibility: who may hand a Supabase session to the capture extension.
//
// Exercises the REAL relayEligibility.ts, transpiled at runtime — the repo's .test.mjs pattern.
// Nothing is stubbed but fetch, which the module takes as an argument for exactly this reason.
//
// THE PROPERTY UNDER TEST is an asymmetry, and it is the whole design: 'eligible' requires a
// definitive yes from the server, while everything else — a no, a 403, a 500, a dropped
// connection, a body we don't recognise — withholds the token. A withheld relay costs a reload;
// a wrongly relayed one writes captures under the wrong user_id and is noticed days later.
//
// Run:  TZ=UTC node src/lib/extension/relayEligibility.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'relayelig-'));
const srcPath = fileURLToPath(new URL('./relayEligibility.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const modPath = join(dir, 'relayEligibility.mjs');
writeFileSync(modPath, outputText);
const { mayRelay, probeRelayEligibility, resolveRelayEligibility, RELAY_ELIGIBILITY_PATH } =
  await import(pathToFileURL(modPath).href);

// ── fetch doubles ──
const respond = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const throws = () => async () => { throw new Error('network down'); };
const badJson = (status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw new SyntaxError('Unexpected token <'); },
});
/** Counts calls and replays a script of responses, repeating the last one. */
function scripted(steps) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step();
  };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

await t('mayRelay: ONLY a confirmed yes relays', () => {
  assert.equal(mayRelay('eligible'), true);
  assert.equal(mayRelay('ineligible'), false);
  assert.equal(mayRelay('unknown'), false, "'unknown' is not a maybe");
});

await t('probe: a confirmed store owner is eligible', async () => {
  assert.equal(await probeRelayEligibility(respond(200, { eligible: true })), 'eligible');
});

await t('probe: a confirmed non-owner is ineligible', async () => {
  assert.equal(await probeRelayEligibility(respond(200, { eligible: false })), 'ineligible');
});

await t('probe: 403 (middleware confinement) is a definitive no', async () => {
  assert.equal(await probeRelayEligibility(respond(403, {})), 'ineligible');
});

await t('probe: a 500 is NOT an answer — unknown, so a caller may retry', async () => {
  assert.equal(await probeRelayEligibility(respond(500, {})), 'unknown');
});

await t('probe: a dropped connection is unknown, never a relay', async () => {
  const got = await probeRelayEligibility(throws());
  assert.equal(got, 'unknown');
  assert.equal(mayRelay(got), false);
});

await t('probe: an unparseable body is unknown, never a relay', async () => {
  assert.equal(await probeRelayEligibility(badJson()), 'unknown');
});

await t('probe: a 200 whose shape we do not recognise is NOT a yes', async () => {
  assert.equal(await probeRelayEligibility(respond(200, { ok: true })), 'unknown');
  assert.equal(await probeRelayEligibility(respond(200, { eligible: 'yes' })), 'unknown');
  assert.equal(await probeRelayEligibility(respond(200, null)), 'unknown');
});

await t('probe: asks the eligibility endpoint, uncached', async () => {
  const f = scripted([respond(200, { eligible: true })]);
  await probeRelayEligibility(f);
  assert.equal(f.calls[0].input, RELAY_ELIGIBILITY_PATH);
  assert.equal(f.calls[0].init?.cache, 'no-store', 'a cached yes could outlive the session');
});

await t('resolve: a definitive answer does not retry', async () => {
  const yes = scripted([respond(200, { eligible: true })]);
  assert.equal(await resolveRelayEligibility(yes, { retries: 2, sleep: noSleep }), 'eligible');
  assert.equal(yes.calls.length, 1);

  const no = scripted([respond(200, { eligible: false })]);
  assert.equal(await resolveRelayEligibility(no, { retries: 2, sleep: noSleep }), 'ineligible');
  assert.equal(no.calls.length, 1, 'a no must never be retried into a yes');
});

await t('resolve: retries only while unknown, then gives up CLOSED', async () => {
  const f = scripted([respond(500, {})]);
  const got = await resolveRelayEligibility(f, { retries: 2, sleep: noSleep });
  assert.equal(got, 'unknown');
  assert.equal(mayRelay(got), false);
  assert.equal(f.calls.length, 3, 'first attempt + 2 retries');
});

await t('resolve: a blip on the owner\'s own machine recovers instead of stopping capture', async () => {
  const f = scripted([respond(500, {}), respond(200, { eligible: true })]);
  assert.equal(await resolveRelayEligibility(f, { retries: 2, sleep: noSleep }), 'eligible');
  assert.equal(f.calls.length, 2, 'stops as soon as it gets an answer');
});

await t('resolve: backs off between retries', async () => {
  const slept = [];
  const f = scripted([respond(500, {})]);
  await resolveRelayEligibility(f, { retries: 2, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(slept.length, 2);
  assert.ok(slept[1] > slept[0], 'delay must grow');
});

for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${err ? ` — ${err}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
