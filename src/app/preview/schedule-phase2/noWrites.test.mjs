// THE SAFETY PROPERTY of /preview/schedule-phase2: it can render the real Phase 2 UI without any
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
const view = strip(read('./Phase2Preview.tsx'));
const fx   = strip(read('./fixtures.ts'));
const all  = [page, view, fx].join('\n');

console.log('\nPREVIEW ROUTE — ZERO WRITE PATH');

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

// 4. It must not import the Phase 2 server-side write helpers either.
for (const m of ['schedule/offer', 'schedule/adminShifts', 'schedule/teamSchedule', 'schedule/release', 'schedule/claim']) {
  const bad = new RegExp(`from\\s+['"][^'"]*${m}['"]`);
  const typeOnly = new RegExp(`import\\s+type[^;]*from\\s+['"][^'"]*${m}['"]`);
  check(`${m} not imported for VALUES (type-only is fine)`, !bad.test(all) || typeOnly.test(all));
}

// 5. The seams must actually be wired, or the real components would fall through to their POSTs.
check('DropShiftButton gets onPreview',   /<DropShiftButton[\s\S]{0,400}?onPreview=/.test(view));
check('CancelOfferButton gets onPreview', /<CancelOfferButton[\s\S]{0,400}?onPreview=/.test(view));
check('TeamSchedule gets onPreviewPickup', /<TeamSchedule[\s\S]{0,300}?onPreviewPickup=/.test(view));
check('PickupRequestsPanel gets both preview props',
  /<PickupRequestsPanel[\s\S]{0,200}?previewRequests=[\s\S]{0,200}?onPreviewAct=/.test(view));

// 6. And the components must honour the seam BEFORE any post(). This is the load-bearing half:
//    the seam is only safe if it returns early.
const parts = strip(read('../../s/[token]/phase2Parts.tsx'));
for (const ep of ['offer', 'cancel-offer', 'pickup']) {
  const idx = parts.indexOf(`/${ep}\``);
  const before = parts.slice(Math.max(0, idx - 260), idx);
  check(`${ep}: onPreview short-circuits before post()`, /if\s*\(onPreview\)\s*\{[^}]*return;/.test(before));
}
const panel = strip(read('../../../components/employees/PickupRequestsPanel.tsx'));
check('manager act(): onPreviewAct returns before fetch',
  /if\s*\(onPreviewAct\)\s*\{[^}]*return;\s*\}/.test(panel)
  && panel.indexOf('onPreviewAct') < panel.indexOf("fetch('/api/admin/schedule/pickups'"));
check('manager load(): previewRequests returns before fetch',
  /if\s*\(previewRequests\)\s*\{[\s\S]{0,200}?return;\s*\}/.test(panel));

// 7. Production must render these components with NO preview props, so live behaviour is unchanged.
const shiftsView = strip(read('../../../components/employees/ShiftsView.tsx'));
check('production mounts PickupRequestsPanel with no props', /<PickupRequestsPanel\s*\/>/.test(shiftsView));
const empPage = strip(read('../../s/[token]/page.tsx'));
check('production employee page passes no onPreview', !/onPreview/.test(empPage));

console.log(`\n${passed} checks passed`);
