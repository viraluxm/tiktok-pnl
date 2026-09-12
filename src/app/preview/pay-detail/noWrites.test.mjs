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
for (const h of ['hooks/useShifts', 'hooks/useShiftRules', 'hooks/useEmployees', 'hooks/useUser', 'hooks/usePayAdjustments']) {
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
  ['the bonus selector', '@/lib/pay/statement', 'bonusSummaryFor'],
  ['the total-owed rule', '@/lib/pay/statement', 'totalOwedOf'],
  ['the edit patch builder', '@/lib/shifts/punchEdit', 'buildShiftEditPatch'],
]) {
  check(`${label} comes from ${spec}`,
    new RegExp(`import \\{[^}]*${name}[^}]*\\} from '${spec.replace('/', '\\/')}'`, 's').test(view));
  check(`${label} is called`, new RegExp(`${name}\\(`).test(view));
}
check('the preview does no hours arithmetic of its own',
  !/paidShiftHours|isPayableShift|hourly_rate\s*\*|\*\s*hourly_rate/.test(view));

// 6b. BONUSES ARE REVIEWED THROUGH THE SHIPPING MODEL TOO. The preview owns an in-memory array of
//     `employee_pay_adjustments` rows and hands it to the production buildPayStatement — it must
//     never work a bonus total out for itself, or the figure approved here would not be the figure
//     that ships.
check('the preview feeds its adjustments into the statement build', /adjustments,/.test(view));
check('...and re-selects them per employee, priced off that employee\'s own payable hours',
  /bonusSummaryFor\(adjustments, p\.employee\.id, period, p\.hours\)/.test(view));
check('...adding them with the shared rule, never by hand',
  /totalOwedOf\(p\.pay, bonus\.total\)/.test(view) &&
    !/amount_cents\s*\+|bonusItems\.reduce|\/ 100|\* 100/.test(view));
check('...and NEVER pricing an hourly bonus itself — no rate x hours in the preview',
  !/rate_cents_per_hour\s*\*|\*\s*p\.hours|\*\s*paidHours/.test(view));
check('the preview hands the bonus write path to the real panel', /bonus=\{bonusHandlers\}/.test(view));
check('the fixtures carry a bonus from ANOTHER pay period, so scoping is visible',
  /period_start: '2026-08-10'/.test(fx) && /period_end: '2026-08-23'/.test(fx));
check('...and a bonus with no description, so the fallback label is visible',
  /description: null/.test(fx));
check('fixture money is integer cents, never dollars',
  /amount_cents: \d+/.test(fx) && !/amount_cents: \d+\.\d/.test(fx) &&
    /rate_cents_per_hour: \d+/.test(fx) && !/rate_cents_per_hour: \d+\.\d/.test(fx));
// BOTH calculation types must be on the page, or half the feature is unreviewed.
check('the fixtures carry FLAT bonuses', /calculation_type: 'flat'/.test(fx));
check('...and HOURLY ones', /calculation_type: 'hourly'/.test(fx));
check('...including one for a LIVE HOST, whose payable hours are the approved duration',
  /employee_id: 'e-adriana'[\s\S]{0,220}calculation_type: 'hourly'/.test(fx));
check('every fixture row sets BOTH money columns, one of them null — the shape the CHECKs require',
  (fx.match(/calculation_type: '(flat|hourly)'/g) || []).length ===
    (fx.match(/rate_cents_per_hour:/g) || []).length);
check('NO fixture row stores a calculated hourly total — the whole point of deriving it',
  !/calculated/i.test(fx));

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
