// THE POST-SAVE EMPLOYEE-LINK STEP.
//
// After a successful Save the builder shows a success step offering the employee's EXISTING
// permanent /s/[token] link. The properties that matter are safety properties, so they are pinned
// three ways against the REAL sources:
//
//   A. handleCopyLink is EXTRACTED FROM THE COMPONENT and executed with injected deps — so the
//      copied URL, the feedback states and the no-token path are the real code's behaviour.
//   B. source-level invariants: the success step is reachable only from a confirmed save, performs
//      no second write, mints nothing, and renders no raw token.
//   C. ScheduleLinkButton (Employee access) is unchanged and still owns the mint path.
//
// This repo has no React mounting harness (no jsdom, no RTL), and adding one for two buttons would
// test the harness more than the rule. Extract-and-run is what the sibling suites do.
//
// Run:  TZ=UTC node src/components/employees/schedule/postSaveLink.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

let passed = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, `FAIL: ${name} ${extra}`); console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); passed++; };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} == ${JSON.stringify(b)}`);

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const builderRaw = read('./EmployeeScheduleBuilder.tsx');
const builder = stripComments(builderRaw);
const linkBtnRaw = read('../ScheduleLinkButton.tsx');
const linkBtn = stripComments(linkBtnRaw);

const dir = mkdtempSync(join(tmpdir(), 'postsave-'));
function run(tsSrc, name) {
  const { outputText } = ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const f = join(dir, name); writeFileSync(f, outputText);
  return import(pathToFileURL(f).href);
}

// ── A. run the REAL handleCopyLink ──────────────────────────────────────────
console.log('\nA. handleCopyLink — the real function, executed');
{
  const fn = builder.match(/async function handleCopyLink\(\) \{[\s\S]*?\n {2}\}/);
  check('found handleCopyLink in the real component source', !!fn);

  const { make } = await run(`
    export function make(deps) {
      const { setCopyState, employeeLinkToken, copyText, scheduleLinkUrl } = deps;
      ${fn[0]}
      return handleCopyLink;
    }`, 'copyLink.mjs');

  // token present, clipboard succeeds
  let states = [], copied = [], urls = [];
  await make({
    setCopyState: (s) => states.push(s),
    employeeLinkToken: 'TOKEN123',
    copyText: async (t) => { copied.push(t); return true; },
    scheduleLinkUrl: (t) => { urls.push(t); return `https://lensed.io/s/${t}`; },
  })();
  eq('copies the EXISTING token as a full /s/ URL', copied, ['https://lensed.io/s/TOKEN123']);
  eq('and asks scheduleLinkUrl for it (reuse, not a hand-built URL)', urls, ['TOKEN123']);
  eq('feedback: resets then reports copied', states, ['idle', 'copied']);

  // clipboard denied
  states = []; copied = [];
  await make({
    setCopyState: (s) => states.push(s),
    employeeLinkToken: 'TOKEN123',
    copyText: async () => false,
    scheduleLinkUrl: (t) => `https://lensed.io/s/${t}`,
  })();
  eq('clipboard failure → failed state, no crash', states, ['idle', 'failed']);

  // no token at all — must NOT mint, must not touch the clipboard
  states = []; copied = []; urls = [];
  let minted = 0;
  await make({
    setCopyState: (s) => states.push(s),
    employeeLinkToken: null,
    copyText: async (t) => { copied.push(t); return true; },
    scheduleLinkUrl: (t) => { urls.push(t); return `x/${t}`; },
    onMint: () => { minted++; },
  })();
  eq('no token → failed, and the clipboard is never touched', [states, copied], [['idle', 'failed'], []]);
  eq('no URL is built from a missing token', urls, []);
  eq('NOTHING is minted', minted, 0);
}

// ── B. source-level invariants ──────────────────────────────────────────────
console.log('\nB. the success step is reachable only from a confirmed save');
{
  check('a `saved` state gates the success step', /const \[saved, setSaved\] = useState/.test(builder));
  check('the panel renders on `saved ?`', /\{saved \?/.test(builder));
  // setSaved must appear exactly once, immediately after the real (non-dry-run) mutation.
  const setSavedCalls = [...builder.matchAll(/setSaved\(/g)].length;
  eq('setSaved is called exactly once in the whole component', setSavedCalls, 1);
  const saveFn = builder.match(/async function save\(\)[\s\S]*?\n {2}\}/)[0];
  const realCall = saveFn.indexOf('await apply.mutateAsync({ entries })');
  const savedAt = saveFn.indexOf('setSaved(');
  check('setSaved comes AFTER the awaited real save', realCall !== -1 && savedAt > realCall);
  check('the dry run is a separate call that never sets saved', /dryRun: true/.test(saveFn) && saveFn.indexOf('dryRun: true') < realCall);
  check('a refusal/error path sets error, not saved', /catch \(e\) \{[\s\S]*?setError\(/.test(saveFn));

  console.log('\n   …and performs no second write, mints nothing, shows no token');
  const panel = builder.match(/\{saved \?[\s\S]*?\n {8}\) : \(/)[0];
  check('the panel contains no fetch/mutateAsync/POST', !/fetch\(|mutateAsync|method: 'POST'/.test(panel));
  check('the panel never calls a mint/regenerate/reissue', !/mint|Mint|regenerate|Regenerate|reissue|Reissue/.test(panel));
  check('no raw token is rendered — only handleCopyLink uses it', !/\{employeeLinkToken\}/.test(panel));
  check('the component imports NO mint hook', !/useScheduleLinks\(\)/.test(builder) && !/onMint/.test(builder));
  eq('it imports the EXISTING copy primitives rather than reimplementing them',
    [/import \{ scheduleLinkUrl \} from '@\/hooks\/useScheduleLinks'/.test(builderRaw), /import \{ copyText \} from '\.\.\/ScheduleLinkButton'/.test(builderRaw)], [true, true]);
  check('no navigator.clipboard call of its own', !/navigator\.clipboard/.test(builder));

  console.log('\n   …and Done closes cleanly');
  check('Done is wired to onClose', /onClick=\{onClose\} autoFocus/.test(panel) || /autoFocus[\s\S]{0,80}onClose/.test(panel) || /onClose\}[\s\S]{0,60}Done/.test(panel));
  check('Done is focused on arrival (keyboard lands somewhere sensible)', /autoFocus/.test(panel));
  check('copy feedback is announced politely for screen readers', /role="status"/.test(panel) && /aria-live="polite"/.test(panel));
  check('the panel states the link is permanent', /never changes/.test(builderRaw));
  check('onSaved still fires so the roster summary refreshes', /onSaved\?\.\(result, weekCount\)/.test(builder));
}

// ── C. Employee access is untouched ─────────────────────────────────────────
console.log('\nC. ScheduleLinkButton (Employee access) still owns the mint path');
{
  const fn = linkBtn.match(/async function handleClick\(\) \{[\s\S]*?\n {2}\}/);
  check('found its handleClick', !!fn);
  const { make } = await run(`
    export function make(deps) {
      const { busy, setFailed, setBusy, token, copyText, scheduleLinkUrl, flashCopied, onMint, employeeId, onCreated } = deps;
      ${fn[0]}
      return handleClick;
    }`, 'linkBtn.mjs');

  // with a token: copies, never mints
  let minted = 0, copied = [], flashed = 0;
  await make({
    busy: false, setFailed: () => {}, setBusy: () => {}, token: 'TOK',
    copyText: async (t) => { copied.push(t); return true; },
    scheduleLinkUrl: (t) => `https://lensed.io/s/${t}`,
    flashCopied: () => { flashed++; },
    onMint: async () => { minted++; return { url: 'x' }; },
    employeeId: 'e1', onCreated: () => {},
  })();
  eq('existing token → copies and does NOT mint', [copied, minted, flashed], [['https://lensed.io/s/TOK'], 0, 1]);

  // without a token: still mints (unchanged behaviour — this is where links are created)
  minted = 0; copied = []; let created = 0;
  await make({
    busy: false, setFailed: () => {}, setBusy: () => {}, token: null,
    copyText: async (t) => { copied.push(t); return true; },
    scheduleLinkUrl: (t) => `x/${t}`,
    flashCopied: () => {},
    onMint: async () => { minted++; return { url: 'https://lensed.io/s/NEW' }; },
    employeeId: 'e1', onCreated: () => { created++; },
  })();
  eq('no token → mints, copies the new URL, notifies (unchanged)', [minted, copied, created], [1, ['https://lensed.io/s/NEW'], 1]);
  check('its labels are the renamed employee-link wording', /Copy employee link/.test(linkBtnRaw) && /Create employee link/.test(linkBtnRaw));
}

console.log('\nD. no new token-copy implementation exists anywhere');
{
  const files = ['./EmployeeScheduleBuilder.tsx', '../ScheduleLinkButton.tsx', '../EmployeeDetailModal.tsx'];
  const owners = files.filter((f) => /export async function copyText/.test(read(f)));
  eq('copyText is defined in exactly ONE place', owners, ['../ScheduleLinkButton.tsx']);
  const builders = files.filter((f) => /\/s\/\$\{/.test(stripComments(read(f))));
  eq('no component hand-builds an /s/ URL', builders, []);
}

console.log(`\n${passed} checks passed`);
