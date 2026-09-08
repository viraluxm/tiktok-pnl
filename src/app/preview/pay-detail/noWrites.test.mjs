// THE SAFETY PROPERTY of /preview/pay-detail: it can render the real Phase 2 UI without any
// path to the database. This asserts that structurally, over the real source, rather than trusting
// a comment — a preview that could POST is exactly the thing the route exists to avoid.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// Comments are stripped first: this codebase explains its own safety at length, and matching the
// explanation instead of the code is how a guard silently rots (it has bitten this repo before).
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };

const page = strip(read('./page.tsx'));
const view = strip(read('./PayDetailPreview.tsx'));
const fx   = strip(read('./fixtures.ts'));
const all  = [page, view, fx].join('\n');

console.log('\nPAY DETAIL PREVIEW ROUTE — ZERO WRITE PATH');

// 1. No network primitives anywhere in the route.
for (const [label, re] of [
  ['fetch(',            /\bfetch\s*\(/],
  ['XMLHttpRequest',    /XMLHttpRequest/],
  ['axios',             /\baxios\b/],
  ['navigator.sendBeacon', /sendBeacon/],
  ['EventSource/WebSocket', /\b(EventSource|WebSocket)\s*\(/],
]) check(`no ${label}`, !re.test(all));

// 2. No Supabase client and no RPC, by import or by call.
for (const [label, re] of [
  ['supabase import',      /from\s+['"][^'"]*supabase[^'"]*['"]/i],
  ['createClient',         /createClient\s*\(/],
  ['createAdminClient',    /createAdminClient/],
  // NOTE: this file deliberately never contains the literal three-character sequence dot-r-p-c
  // followed by an open paren. scripts/check-rpc-grants.mjs greps source for it and would read an
  // occurrence here — even inside a regex or a comment — as an un-annotated dynamic RPC call, and
  // fail that check on this test. The pattern is assembled at runtime instead.
  ['supabase rpc call',    new RegExp('\\.' + 'rpc' + '\\s*\\(')],
  ['.insert(/.update(/.delete(', /\.(insert|update|upsert|delete)\s*\(/],
]) check(`no ${label}`, !re.test(all));

// 3. No server action (a 'use server' function would be an invisible write path).
check("no 'use server' directive", !/['"]use server['"]/.test(all));

// 4. No data hook either. useShifts / useShiftRules issue the production queries and mutations;
//    importing one here would give the page a live client through the back door.
for (const h of ['hooks/useShifts', 'hooks/useShiftRules', 'hooks/useEmployees', 'hooks/useUser']) {
  const bad = new RegExp(`from\\s+['"][^'"]*${h}['"]`);
  check(`${h} not imported`, !bad.test(all));
}

// 5. It must render the REAL components, not a fork of them. A preview that quietly reimplements
//    the UI approves something that will never ship.
for (const c of ['PayGrid', 'PayDetailModal', 'ShiftEditorModal']) {
  check(`${c} is imported from the production component`,
    new RegExp(`import ${c}[^;]*from '@/components/employees/`).test(view));
  check(`${c} is actually rendered`, new RegExp(`<${c}[\\s\\n]`).test(view));
}

// 6. And the REAL payroll math. This is the load-bearing half: the whole point of the review is
//    that the numbers on screen are produced by the shipping code.
for (const [label, spec, name] of [
  ['the payroll totals', '@/lib/employees', 'computePay'],
  ['the statement model', '@/lib/pay/statement', 'buildPayStatement'],
  ['the edit patch builder', '@/lib/shifts/punchEdit', 'buildShiftEditPatch'],
]) {
  check(`${label} comes from ${spec}`,
    new RegExp(`import \\{[^}]*${name}[^}]*\\} from '${spec.replace('/', '\\/')}'`, 's').test(view));
  check(`${label} is called`, new RegExp(`${name}\\(`).test(view));
}
check('the preview does no hours arithmetic of its own',
  !/paidShiftHours|isPayableShift|hourly_rate\s*\*|\*\s*hourly_rate/.test(view));

// 7. Production must not depend on the preview. Fixtures leaking into the app would put invented
//    employees one import away from a real Pay tab.
const payView = strip(read('../../../components/employees/PayView.tsx'));
const payGrid = strip(read('../../../components/employees/PayGrid.tsx'));
const payModal = strip(read('../../../components/employees/PayDetailModal.tsx'));
for (const [label, code] of [['PayView', payView], ['PayGrid', payGrid], ['PayDetailModal', payModal]]) {
  check(`${label} does not import anything from preview/`, !/from\s+['"][^'"]*preview\//.test(code));
}
check('PayView still feeds computePay the period rows only',
  /computePay\(employees, periodShifts\)/.test(payView));

// 8. The route itself must be gated, and gated before it renders anything.
check('page.tsx applies the preview gate', /isPreviewRouteAllowed\(\)/.test(page));
check('...and 404s when it is not allowed', /notFound\(\)/.test(page));
check('...before rendering the preview',
  page.indexOf('isPreviewRouteAllowed') < page.indexOf('<PayDetailPreview'));

console.log(`\n${passed} checks passed`);
