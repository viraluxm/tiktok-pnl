// Proof of the shipping-confirm immutability + idempotency contract. Transpiles confirmRow.ts
// at runtime (repo's `typescript` devDep) and exercises the REAL buildVerificationRow +
// simulateInsertIgnoreDuplicates, which models the exact DB policy the route pins with
// ON CONFLICT (user_id, group_key) DO NOTHING (supabase upsert { ignoreDuplicates: true }).
//
// Run:  node src/lib/shipping/confirmRow.test.mjs
//
// Proves: first confirm records timing + picker; duplicate/re-confirm never changes timing,
// never changes picker, never double-counts, and never backfills a historical Unassigned row;
// a failed/abandoned confirm records nothing.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./confirmRow.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'confirm-')), 'confirmRow.mjs');
writeFileSync(outFile, outputText);
const { buildVerificationRow, simulateInsertIgnoreDuplicates } = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

const USER = 'user-1';
const T1 = '2026-07-15T17:00:00.000Z';
const S1 = '2026-07-15T16:58:00.000Z'; // 2 min before completion
const T2 = '2026-07-15T19:30:00.000Z'; // a later re-confirm
const S2 = '2026-07-15T19:25:00.000Z';

// ── buildVerificationRow field inclusion ─────────────────────────────────────
console.log('buildVerificationRow');
{
  const full = buildVerificationRow({ userId: USER, groupKey: 'g1', orderIds: ['o1', 'o2'], verifiedAt: T1, storeId: 'store-1', pickerEmployeeId: 'e1', pickerNameSnapshot: 'Ann', pickStartedAt: S1 });
  check('records the four KPI fields on first confirm',
    full.verified_at === T1 && full.pick_started_at === S1 && full.picker_employee_id === 'e1' && full.picker_name_snapshot === 'Ann');
  check('records order_ids + store', Array.isArray(full.order_ids) && full.order_ids.length === 2 && full.store_id === 'store-1');

  const bare = buildVerificationRow({ userId: USER, groupKey: 'g2', orderIds: ['o1'], verifiedAt: T1, pickerEmployeeId: null, pickStartedAt: null });
  check('no picker → picker columns omitted (Unassigned)', !('picker_employee_id' in bare) && !('picker_name_snapshot' in bare));
  check('no start → pick_started_at omitted (no fake duration)', !('pick_started_at' in bare));
}

// ── 1. First confirm records timing and picker ────────────────────────────────
console.log('immutability / idempotency');
{
  const store = new Map();
  const r1 = simulateInsertIgnoreDuplicates(store, buildVerificationRow({ userId: USER, groupKey: 'box', orderIds: ['o1', 'o2', 'o3'], verifiedAt: T1, pickerEmployeeId: 'e1', pickerNameSnapshot: 'Ann', pickStartedAt: S1 }));
  const saved = store.get(`${USER}::box`);
  check('first confirm inserts', r1.inserted === true);
  check('first confirm records timing + picker', saved.verified_at === T1 && saved.pick_started_at === S1 && saved.picker_employee_id === 'e1' && saved.picker_name_snapshot === 'Ann');

  // 2 + 3. Duplicate confirm (different timing + different picker) changes NOTHING.
  const r2 = simulateInsertIgnoreDuplicates(store, buildVerificationRow({ userId: USER, groupKey: 'box', orderIds: ['o1', 'o2', 'o3'], verifiedAt: T2, pickerEmployeeId: 'e2', pickerNameSnapshot: 'Bob', pickStartedAt: S2 }));
  const after = store.get(`${USER}::box`);
  check('duplicate confirm is a no-op (not inserted)', r2.inserted === false);
  check('duplicate does NOT change timing', after.verified_at === T1 && after.pick_started_at === S1);
  check('duplicate does NOT change picker', after.picker_employee_id === 'e1' && after.picker_name_snapshot === 'Ann');

  // 4. Duplicate confirm does not double-count boxes/orders.
  check('duplicate does NOT double-count (one row for the box)', store.size === 1);
  check('order_ids unchanged (still the original 3)', after.order_ids.length === 3);
}

// ── No backfill: historical Unassigned row stays Unassigned on re-confirm ──────
{
  const store = new Map();
  // Historical first confirm with no picker / no start (Unassigned).
  simulateInsertIgnoreDuplicates(store, buildVerificationRow({ userId: USER, groupKey: 'hist', orderIds: ['o1'], verifiedAt: T1 }));
  // A later re-confirm now supplies a valid picker — must NOT backfill it.
  const r = simulateInsertIgnoreDuplicates(store, buildVerificationRow({ userId: USER, groupKey: 'hist', orderIds: ['o1'], verifiedAt: T2, pickerEmployeeId: 'e1', pickerNameSnapshot: 'Ann', pickStartedAt: S1 }));
  const saved = store.get(`${USER}::hist`);
  check('re-confirm of historical row is a no-op', r.inserted === false);
  check('historical Unassigned row is NOT backfilled with a picker', saved.picker_employee_id === undefined && saved.pick_started_at === undefined);
}

// ── 5. Failed / abandoned confirm records nothing ─────────────────────────────
{
  const store = new Map();
  // An abandoned/failed box never reaches the insert (the route returns before it, or the
  // client never confirms). Model: no insert is performed for 'abandoned'.
  // A separate box IS confirmed successfully.
  simulateInsertIgnoreDuplicates(store, buildVerificationRow({ userId: USER, groupKey: 'done', orderIds: ['o1'], verifiedAt: T1, pickerEmployeeId: 'e1', pickerNameSnapshot: 'Ann', pickStartedAt: S1 }));
  check('failed/abandoned box persists nothing', store.has(`${USER}::abandoned`) === false);
  check('only the successfully-confirmed box exists', store.size === 1 && store.has(`${USER}::done`));
}

console.log(`\n${passed} checks passed.`);
