// The manager-facing /team/staff hours must be the SAME numbers payroll pays.
//
// This has now drifted twice. The failure mode is silent and specific: a surface computes hours
// from `shifts.start_time`/`end_time` (the wall clock) while payroll reads the punch INSTANTS and,
// since migration 137, `approved_minutes` — which WINS whenever a manager set it. The screen then
// disagrees with Pay on exactly the time-clock rows a manager opened it to check, and nothing
// errors. So this is a source scan, not a behaviour test: it asserts the derivation is IMPORTED,
// never re-implemented, and that the projection feeding it carries every field that derivation
// reads. A projection missing the instants is the same defect that produced the diverged
// production rows behind #170.
//
// Run: node --test src/lib/schedule/memberStaffHours.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
// Comments are evidence of intent, not of behaviour — strip them so a mention in prose never
// satisfies an assertion about code.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const PAGE = '../../app/(station)/team/staff/page.tsx';
const ROUTE = '../../app/api/member/team/shifts/route.ts';

test('the route projects every field the shared derivation reads', () => {
  const route = code(ROUTE);
  for (const col of ['clock_in_at', 'clock_out_at', 'approved_minutes', 'source_rule_id',
                     'confirmed_at', 'break_minutes', 'auto_closed']) {
    assert.ok(route.includes(col), `shifts projection is missing ${col}`);
  }
});

test('the route still leaks no money', () => {
  const route = code(ROUTE);
  for (const forbidden of ['hourly_rate', 'unit_cost', 'cents', 'revenue']) {
    assert.ok(!route.includes(forbidden), `${forbidden} must never reach a member surface`);
  }
  assert.ok(!/\.select\('\*'\)/.test(route), 'explicit column lists only');
});

test('the page imports the shared derivation instead of writing its own', () => {
  const page = code(PAGE);
  assert.ok(page.includes('toTimecardEntry'), 'must derive hours through toTimecardEntry');
  assert.ok(/from '@\/lib\/schedule\/timecardModel'/.test(page), 'imported, not copied');
});

test('the page performs NO local duration arithmetic on shift times', () => {
  const page = code(PAGE);
  // The exact shapes the two previous regressions took.
  assert.ok(!/toMin\(s\.end_time\)/.test(page), 'subtracting wall-clock times locally');
  assert.ok(!/break_minutes \?\? 0\)? *\/ *60/.test(page), 'deriving break hours locally');
  assert.ok(!/mins \+= 24 \* 60/.test(page), 'local overnight wrap');
  // 24*60 in any form is the fingerprint of a hand-rolled midnight wrap.
  assert.ok(!/24 \* 60/.test(page), 'no hand-rolled midnight wrap');
});

test('both quantities are shown, because they answer different questions', () => {
  const page = code(PAGE);
  assert.ok(page.includes('clocked_hours'), 'CLOCKED (attendance) must be visible');
  assert.ok(/'Clocked'/.test(page) && /'Approved'/.test(page), 'both columns must be labelled');
});
