// The label-stack read MUST be paged.
//
// PostgREST caps a response at 1000 rows and reports nothing — no error, no header, no partial
// flag. On 2026-09-06 that silently truncated a three-run "Singles only" print: 2,410 rows
// existed, 1,000 came back, and a 976-label stack built 239. The PDF opened cleanly and the
// count was simply wrong, which is the only failure mode this cap has.
//
// This is a SOURCE posture check rather than a behavioural one: the read lives inside a route
// handler that needs a request, a session and a Supabase admin client, so the cheap and durable
// guard is that the query goes through readAllPaged and carries a deterministic order.
//
// Run:  node src/app/api/shipping/labels/pdf/rowPaging.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Control: prove the fixture is the file we think it is, so a rename cannot make this vacuous.
check('the route really reads the ledger',
  src.includes("from('shipping_label_purchases')"));
check('…and really selects the ledger columns', src.includes('LEDGER_COLUMNS'));

check('the read is paged', src.includes('readAllPaged'));
check('…and readAllPaged is imported, not merely mentioned',
  /import\s*\{[^}]*\breadAllPaged\b[^}]*\}\s*from\s*'@\/lib\/db\/readAll'/.test(src));

// readAllPaged pages with .range(), which is meaningless without a total order — an unordered
// paged read can return the same row twice and miss another.
check('the paged query applies .range from its offsets', /\.range\(from,\s*to\)/.test(src));
check('…under a deterministic order', /\.order\(/.test(src));
check('…whose final key is unique per row, so pages cannot overlap',
  /\.order\('group_key'/.test(src), 'group_key is the ledger box key');

// The specific shape that caused the incident: a ledger select in the stack-read region that
// is not the paged one. Checked by position rather than by trying to excise the paged block —
// every ledger read here must be introduced by readAllPaged.
const region = src.slice(src.indexOf('const runIds'), src.indexOf('const merge ='));
const selects = [...region.matchAll(/\.from\('shipping_label_purchases'\)/g)];
check('the stack-read region makes exactly one ledger read',
  selects.length === 1, `${selects.length} found`);
check('…and readAllPaged opens it',
  region.lastIndexOf('readAllPaged', selects[0].index) !== -1
  && region.slice(region.lastIndexOf('readAllPaged', selects[0].index), selects[0].index).length < 200,
  'the select sits inside the readAllPaged callback');

console.log(`\n${passed} checks passed`);
