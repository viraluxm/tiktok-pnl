// Proof for the refund pack-guard. The expensive mistake here is shipping a refunded box, so the
// tests are weighted toward "does an unexpected status block".
// Run:  node src/lib/shipping/refundGuard.test.mjs
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const src = readFileSync(new URL('./refundGuard.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { blocksPacking, packBlockHeadline, REASON_CANCELED } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) { console.log(`  ok   ${name}`); return; }
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  fails++;
};

console.log('\nA completed refund blocks');
for (const s of [
  'RETURN_OR_REFUND_REQUEST_COMPLETE', 'REFUND_SUCCESS', 'CANCELLATION_REQUEST_SUCCESS',
  'COMPLETED', 'REFUND_COMPLETE', 'CANCELLED',
]) eq(s, blocksPacking(s), true);

console.log('\nAn IN-FLIGHT refund blocks too (a box shipped mid-refund is a box gone)');
for (const s of [
  'RETURN_OR_REFUND_REQUEST_WAITING_FOR_SELLER_TO_PROCESS', 'AWAITING_BUYER_SHIP',
  'BUYER_SHIPPED_ITEM', 'SELLER_RECEIVE_AND_CHECK_ITEM', 'AWAITING_SELLER_APPROVAL',
  'IN_PROGRESS', 'REQUESTED', 'PENDING', 'PROCESSING', 'CANCELLATION_REQUEST_PENDING',
]) eq(s, blocksPacking(s), true);

console.log('\nOnly a DEAD request lets the order ship');
for (const s of [
  'RETURN_OR_REFUND_REQUEST_REJECT', 'REFUND_REJECTED', 'SELLER_DECLINED',
  'CANCELLATION_REQUEST_FAILED', 'BUYER_WITHDRAW', 'CANCELLATION_REQUEST_CANCELLED',
]) eq(s, blocksPacking(s), false);

console.log('\nUnknown / missing blocks — the safe direction for an enum we do not control');
for (const s of [null, undefined, '', 'SOME_STATUS_TIKTOK_ADDS_IN_2027', 'WEIRD']) {
  eq(JSON.stringify(s), blocksPacking(s), true);
}

console.log('\nNormalisation');
eq('lowercase', blocksPacking('refund_success'), true);
eq('spaces and hyphens', blocksPacking('cancellation request - failed'), false);

console.log('\nThe banner the picker reads');
{
  const h = packBlockHeadline([{ order_id: 'a', reason: REASON_CANCELED }, { order_id: 'b', reason: REASON_CANCELED }]);
  eq('all cancelled -> the operator\'s wording', h.title, 'ORDER CANCELED, NO NEED TO PACK');
  eq('and says to bin the label', /bin the label/i.test(h.detail), true);
}
{
  // Not all cancelled: must NOT claim the order was cancelled.
  const h = packBlockHeadline([{ order_id: 'a', reason: REASON_CANCELED }, { order_id: 'b', reason: 'IN_TRANSIT' }]);
  eq('mixed reasons -> generic title', h.title, 'Nothing to pack');
  eq('mixed reasons name what is there', h.detail.includes('IN_TRANSIT'), true);
}
{
  const h = packBlockHeadline([{ order_id: 'a', reason: 'COMPLETED' }]);
  eq('already-shipped is not reported as cancelled', h.title, 'Nothing to pack');
}
eq('no exclusions -> generic, never the cancelled claim',
  packBlockHeadline([]).title, 'Nothing to pack');

console.log('\nStructural: the reason must come from the same decision that excluded the order');
{
  const { execSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  // A route that filters on packStatus but labels with effStatus reports a refunded order as
  // COMPLETED, and the picker is told the wrong thing about a box that must not ship.
  const mislabel = execSync(
    `grep -rn "reason: effStatus" "${root}/src" "--include=*.ts" || true`,
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  eq('no route labels an exclusion with effStatus (it ignores refunds)', mislabel.length, 0);

  // Every route that partitions the box must consult the refund guard, not just one of them.
  const routes = execSync(
    `grep -rln "excludedOrderIds" "${root}/src/app/api" "--include=*.ts" || true`,
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  const withGuard = routes.filter((f) => /refundBlockedOrders/.test(
    execSync(`cat "${f}"`, { encoding: 'utf8' })));
  eq(`all ${routes.length} pick routes consult the refund guard`, withGuard.length, routes.length);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
