// THE SAFETY PROPERTY of /preview/employee-portal: it renders the real portal with no path to the
// database. Asserted structurally over the comment-stripped source (a comment explaining the
// safety must never be what keeps this green).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let passed = 0;
const check = (n, c) => { assert.ok(c, `FAIL: ${n}`); console.log(`  ✓ ${n}`); passed++; };

const page = strip(read('./page.tsx'));
const view = strip(read('./PortalPreview.tsx'));
const fx   = strip(read('./fixtures.ts'));
const ty   = strip(read('./types.ts'));
const all  = [page, view, fx, ty].join('\n');

console.log('\nPREVIEW ROUTE — ZERO WRITE PATH');

// 1. No network primitives anywhere in the route.
for (const [label, re] of [
  ['fetch(',                /\bfetch\s*\(/],
  ['XMLHttpRequest',        /XMLHttpRequest/],
  ['axios',                 /\baxios\b/],
  ['navigator.sendBeacon',  /sendBeacon/],
  ['EventSource/WebSocket', /\b(EventSource|WebSocket)\s*\(/],
]) check(`no ${label}`, !re.test(all));

// 2. No Supabase client and no RPC, by import or by call.
for (const [label, re] of [
  ['supabase import',   /from\s+['"][^'"]*supabase[^'"]*['"]/i],
  ['createClient',      /createClient\s*\(/],
  ['createAdminClient', /createAdminClient/],
  // assembled at runtime so scripts/check-rpc-grants.mjs never reads this file as a dynamic RPC call
  ['supabase rpc call', new RegExp('\\.' + 'rpc' + '\\s*\\(')],
  ['.insert(/.update(/.delete(', /\.(insert|update|upsert|delete)\s*\(/],
]) check(`no ${label}`, !re.test(all));

// 3. No server action.
check("no 'use server' directive", !/['"]use server['"]/.test(all));

// 4. The production fetch client is never constructed here — the seam is the in-memory client.
check('createFetchPortalClient is not imported or called', !/createFetchPortalClient/.test(all));
check('PortalRoot (the production client boundary) is not used', !/PortalRoot/.test(all));

// 5. No VALUE import of any server-side schedule module (type-only is fine).
for (const m of ['schedule/offer', 'schedule/adminShifts', 'schedule/teamSchedule', 'schedule/mySchedule', 'schedule/release', 'schedule/claim',
                 'schedule/trade', 'schedule/timecard', 'schedule/portalSnapshot', 'schedule/board', 'schedule/tokens', 'schedule/publicRoute']) {
  const bad = new RegExp(`from\\s+['"][^'"]*${m}['"]`);
  const typeOnly = new RegExp(`import\\s+type[^;]*from\\s+['"][^'"]*${m}['"]`);
  check(`${m} not imported for VALUES`, !bad.test(all) || typeOnly.test(all));
}
// The modules it DOES import must themselves be client-safe (no 'server-only').
for (const rel of ['../../../lib/schedule/timecardModel.ts', '../../../lib/schedule/tradePlan.ts', '../../../lib/schedule/hours.ts', '../../../lib/schedule/timezone.ts', '../../../lib/employees.ts', '../../../lib/labor.ts', '../../../lib/schedule/portalModel.ts', '../../../components/portal/client.ts']) {
  check(`${rel.split('/').pop()} carries no 'server-only'`, !/['"]server-only['"]/.test(strip(read(rel))));
}

// 6. The seams must be wired: the in-memory client is what PortalProvider receives, and the
//    manager panels get their preview props (they return before any fetch).
check('PortalProvider receives the in-memory client', /<PortalProvider[^>]*client=\{client\}/.test(view));
check('PickupRequestsPanel gets both preview props', /<PickupRequestsPanel[\s\S]{0,200}?previewRequests=[\s\S]{0,200}?onPreviewAct=/.test(view));
check('TradeRequestsPanel gets both preview props', /<TradeRequestsPanel[\s\S]{0,200}?previewTrades=[\s\S]{0,200}?onPreviewAct=/.test(view));
const trades = strip(read('../../../components/employees/TradeRequestsPanel.tsx'));
check('TradeRequestsPanel act(): onPreviewAct returns before fetch', /if\s*\(onPreviewAct\)\s*\{[^}]*return;\s*\}/.test(trades) && trades.indexOf('onPreviewAct') < trades.indexOf("fetch('/api/admin/schedule/trades'"));
check('TradeRequestsPanel load(): previewTrades returns before fetch', /if\s*\(previewTrades\)\s*\{[\s\S]{0,200}?return;\s*\}/.test(trades));

// 7. Production must mount the panels with NO preview props, and the real page must use the fetch client.
const shiftsView = strip(read('../../../components/employees/ShiftsView.tsx'));
check('production mounts PickupRequestsPanel with no props', /<PickupRequestsPanel\s*\/>/.test(shiftsView));
check('production mounts TradeRequestsPanel with no props', /<TradeRequestsPanel\s*\/>/.test(shiftsView));
const root = strip(read('../../../components/portal/PortalRoot.tsx'));
check('production PortalRoot builds the fetch client from the token', /createFetchPortalClient\(token\)/.test(root));

console.log(`\n${passed} checks passed`);
