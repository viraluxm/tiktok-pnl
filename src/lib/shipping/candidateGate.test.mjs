// Proof for the gates that decide which boxes may be bought. Each one exists because of a way
// money gets wasted: a label bought for a group still combining, or for a subset of a group.
// Run:  node src/lib/shipping/candidateGate.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./candidateGate.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'cg-')), 'candidateGate.mjs');
writeFileSync(outFile, outputText);
const { gateByAge, gateByVerifiedStatus, groupIntoBoxes, MIN_ORDER_AGE_HOURS } =
  await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const NOW = Date.parse('2026-09-04T07:00:00Z');
const HOUR = 3_600_000;
const agoH = (h) => new Date(NOW - h * HOUR).toISOString();
/** A box whose orders were created the given numbers of hours ago. */
const box = (key, ...ages) => ({
  group_key: key,
  orders: ages.map((h, i) => ({ order_id: `${key}-o${i}`, order_created_at: h === null ? null : agoH(h) })),
});

console.log('\nThe age floor');
{
  check('the floor is 6 hours', MIN_ORDER_AGE_HOURS === 6);
  check('a day-old single order passes', gateByAge(box('a', 24), NOW).ok === true);
  check('an order exactly at the floor passes', gateByAge(box('a', 6), NOW).ok === true);
  const young = gateByAge(box('a', 5.9), NOW);
  check('an order just under the floor is held back', young.ok === false);
  check('…and the reason names the age and the floor',
    young.reason.includes('5.9h') && young.reason.includes('6h'), young.reason);
  const fresh = gateByAge(box('a', 0.1), NOW);
  check('a minutes-old order is held back', fresh.ok === false, fresh.reason);
}

console.log('\nThe YOUNGEST order in a box decides');
{
  // THE case this exists for. A group whose oldest order is a week old but which gained a new
  // sibling ten minutes ago is still growing. Buying now locks the old ones into their own
  // parcels and the combine never happens: two labels, two boxes, one buyer.
  const mixed = gateByAge(box('g', 168, 72, 0.2), NOW);
  check('one fresh member holds back the whole box', mixed.ok === false, mixed.reason);
  check('…and the reason reports the YOUNGEST, not the oldest',
    mixed.reason.includes('0.2h'), mixed.reason);
  check('a box where every member has aged out passes',
    gateByAge(box('g', 168, 72, 6.5), NOW).ok === true);
  // Boundary: all old but one exactly at the floor.
  check('a member exactly at the floor does not hold the box back',
    gateByAge(box('g', 100, 6), NOW).ok === true);
}

console.log('\nA missing date is treated as YOUNG, not old');
{
  // Refusing to buy is recoverable; buying a label for a group that may still be forming is
  // not. So an unknown date takes the safe direction, and is reported distinctly so a
  // systematic gap shows up as a named exclusion rather than a quietly shrinking plan.
  const nul = gateByAge(box('a', null), NOW);
  check('an undated order is held back', nul.ok === false);
  check('…with a reason that says the date is the problem',
    nul.reason.includes('no usable order date'), nul.reason);
  const partial = gateByAge(box('g', 100, null), NOW);
  check('one undated order in an otherwise-old box holds it back', partial.ok === false);
  check('…and the reason counts how many', partial.reason.includes('1 of 2'), partial.reason);
  check('an unparseable date is treated the same as missing',
    gateByAge({ group_key: 'x', orders: [{ order_id: 'x', order_created_at: 'whenever' }] }, NOW).ok === false);
  check('an empty box is refused rather than passing vacuously',
    gateByAge({ group_key: 'x', orders: [] }, NOW).ok === false);
}
{
  // A future-dated order (clock skew) must not read as "very young forever" nor as old.
  const future = gateByAge({ group_key: 'f', orders: [{ order_id: 'f', order_created_at: new Date(NOW + HOUR).toISOString() }] }, NOW);
  check('a future-dated order is held back, not treated as aged', future.ok === false);
  check('…and says so plainly rather than reporting a negative age',
    future.reason.includes('dated in the future') && !future.reason.includes('-'), future.reason);
}

console.log('\nA custom floor is honoured');
{
  check('a 2-hour floor lets a 3-hour-old box through',
    gateByAge(box('a', 3), NOW, 2).ok === true);
  check('a 24-hour floor holds the same box back',
    gateByAge(box('a', 3), NOW, 24).ok === false);
}

console.log('\nPartial boxes are refused after verification');
{
  const st = (m) => new Map(Object.entries(m));
  const b = box('g', 100, 100, 100);
  const ids = b.orders.map((o) => o.order_id);

  check('a box whose every order is still awaiting passes',
    gateByVerifiedStatus(b, st(Object.fromEntries(ids.map((i) => [i, 'AWAITING_SHIPMENT'])))).ok === true);

  // THE case. One sibling already has a label. The old code kept the other two and bought a
  // label naming a SUBSET of the combine group — untested against TikTok, and every plausible
  // outcome is bad.
  const partial = gateByVerifiedStatus(b, st({
    [ids[0]]: 'AWAITING_SHIPMENT', [ids[1]]: 'AWAITING_SHIPMENT', [ids[2]]: 'AWAITING_COLLECTION',
  }));
  check('a box with one order moved on is refused whole', partial.ok === false);
  check('…and the reason says it is partial and why that matters',
    partial.reason.includes('partial box') && partial.reason.includes('subset'), partial.reason);
  check('…and names the offending order and its status',
    partial.reason.includes(ids[2]) && partial.reason.includes('AWAITING_COLLECTION'), partial.reason);

  const allGone = gateByVerifiedStatus(b, st(Object.fromEntries(ids.map((i) => [i, 'IN_TRANSIT']))));
  check('a box entirely moved on reads as a plain status change, not "partial"',
    allGone.ok === false && !allGone.reason.includes('partial'), allGone.reason);

  const missing = gateByVerifiedStatus(b, st({ [ids[0]]: 'AWAITING_SHIPMENT', [ids[1]]: 'AWAITING_SHIPMENT' }));
  check('an order TikTok did not return is treated as moved, not as fine',
    missing.ok === false && missing.reason.includes('not found'), missing.reason);
  check('a single-order box is never called partial',
    gateByVerifiedStatus(box('s', 100), st({ 's-o0': 'CANCELLED' })).reason.includes('partial') === false);
}

console.log('\nGrouping into boxes');
{
  const boxes = groupIntoBoxes([
    { order_id: 'o1', auto_combine_group_id: 'g1', order_created_at: agoH(10) },
    { order_id: 'o2', auto_combine_group_id: 'g1', order_created_at: agoH(9) },
    { order_id: 'o3', auto_combine_group_id: null, order_created_at: agoH(8) },
  ]);
  check('shared group ids collapse into one box', boxes.length === 2, String(boxes.length));
  const g1 = boxes.find((b) => b.group_key === 'g1');
  check('the combined box holds both orders', g1.orders.length === 2);
  check('an order with no group id stands alone under an "order:" key',
    boxes.some((b) => b.group_key === 'order:o3'), boxes.map((b) => b.group_key).join(','));
  check('creation dates survive grouping', g1.orders.every((o) => typeof o.order_created_at === 'string'));
}
{
  // Determinism: two runs over the same data must gate and plan identically.
  const rows = [
    { order_id: 'b', auto_combine_group_id: 'g', order_created_at: agoH(3) },
    { order_id: 'a', auto_combine_group_id: 'g', order_created_at: agoH(9) },
    { order_id: 'c', auto_combine_group_id: 'h', order_created_at: agoH(9) },
  ];
  const one = JSON.stringify(groupIntoBoxes(rows));
  const two = JSON.stringify(groupIntoBoxes(rows.slice().reverse()));
  check('input order does not change the grouping', one === two);
  // And the mixed-age group is correctly held back as a unit.
  const g = groupIntoBoxes(rows).find((b) => b.group_key === 'g');
  check('a group with one recent order is held back after grouping',
    gateByAge(g, NOW).ok === false, gateByAge(g, NOW).reason);
  const h = groupIntoBoxes(rows).find((b) => b.group_key === 'h');
  check('…while its all-old neighbour passes', gateByAge(h, NOW).ok === true);
}
{
  check('no candidates means no boxes', groupIntoBoxes([]).length === 0);
}

console.log(`\n${passed} checks passed\n`);
