// Security invariants for the tokenised practice-host route (/p/[token]).
//
// This is the one surface where a person with NO Lensed account reaches the app, so
// these assertions are about the boundary, not the behaviour. Every one of them
// corresponds to a specific way the design could be undone by a later edit.
//
// Run:  node src/lib/training/hostToken.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tokenLib = read('./hostToken.ts');
const guard = read('./hostRouteGuard.ts');
const transport = read('./transport.ts');
const publicRt = read('../supabase/publicRealtime.ts');
// Strip comments before asserting on any of these: several of the files
// deliberately NAME the thing they must not use, while explaining why. Testing raw
// file text would then pass or fail on prose rather than on code.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const publicRtCode = stripComments(publicRt);
const channel = read('./useSessionChannel.ts');
const middleware = read('../../middleware.ts');
const page = read('../../app/p/[token]/page.tsx');
const lkRoute = read('../../app/api/host/[token]/livekit-token/route.ts');
const eventsRoute = read('../../app/api/host/[token]/events/route.ts');
const heartbeatRoute = read('../../app/api/host/[token]/heartbeat/route.ts');
const recStart = read('../../app/api/host/[token]/recording-start/route.ts');
const simulator = read('../../components/training/LiveSimulator.tsx');
const launcher = read('../../components/training/PracticeModeLauncher.tsx');
const migration = (() => {
  const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
  const f = readdirSync(dir).find((n) => n.endsWith('_practice_host_token.sql'));
  return f ? readFileSync(dir + f, 'utf8') : '';
})();

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── NO SUPABASE AUTH SESSION, ANYWHERE ON THIS PATH ──
// The capture extension relays whatever session it observes on a machine; a second
// session makes captures write under the wrong user_id, silently. That is the
// 2026-07-22 incident, and it is why this route must create no session at all.
check(
  'middleware excludes BOTH the page and the API from updateSession',
  /api\/host\//.test(middleware) && /\|p\/\|/.test(middleware),
);
check(
  'the public Realtime client does NOT import the cookie-managing ssr helper',
  !/@supabase\/ssr/.test(publicRtCode) &&
    !/createBrowserClient/.test(publicRtCode) &&
    /from '@supabase\/supabase-js'/.test(publicRtCode),
);
check(
  'it disables persistSession, autoRefreshToken and detectSessionInUrl',
  /persistSession: false/.test(publicRtCode) &&
    /autoRefreshToken: false/.test(publicRtCode) &&
    /detectSessionInUrl: false/.test(publicRtCode),
);
check('it never signs in', !/signIn|signUp|setSession/.test(publicRtCode));
check(
  'the tokenised page passes mode:token so the session-less client is used',
  /mode: 'token'/.test(page),
);
check(
  'the simulator picks the session-less Realtime client from the mode, not a guess',
  /const sessionless = transport\.mode === 'token'/.test(simulator) &&
    /sessionless,/.test(simulator),
);
check(
  'useSessionChannel actually honours that flag',
  /sessionless \? createPublicRealtimeClient\(\) : createClient\(\)/.test(channel),
);

// ── THE TOKEN, NOT THE SESSION ID, IS THE CREDENTIAL ──
check(
  'tokens are 32 random bytes base64url, generated in app code',
  /randomBytes\(32\)\.toString\('base64url'\)/.test(tokenLib),
);
check(
  'the resolver rejects obviously-short tokens before touching the DB',
  /token\.length < 20/.test(tokenLib),
);
check(
  'an ENDED session cannot be resolved (ending a session revokes its link)',
  /data\.ended_at !== null/.test(tokenLib) && /return null/.test(tokenLib),
);
check(
  'there is deliberately no expiry column to drift from ended_at',
  // No expiry COLUMN, and the reasoning is recorded. The wording is matched
  // loosely because SQL comments wrap across lines with a leading '--'.
  !/expires_at|expires_/.test(migration) && /separate\s+(?:--\s*)?expiry/i.test(migration),
);
check(
  'every miss returns the SAME 404, so the route is not an oracle for valid tokens',
  /Not found/.test(guard) && /status: 404/.test(guard),
);
check(
  'the page renders one bare 404 for unknown AND ended',
  /notFound\(\)/.test(page) && /not an oracle/i.test(page),
);

// ── SCOPING IS EXPLICIT, BECAUSE RLS IS BYPASSED BY SERVICE-ROLE ──
check(
  'the resolver looks the token up by host_token, not by session id',
  /\.eq\('host_token', token\)/.test(tokenLib),
);
for (const [name, src] of [
  ['heartbeat', heartbeatRoute],
  ['recording-start', recStart],
]) {
  check(
    `${name} filters by the RESOLVED session, never a body-supplied one`,
    /session\.sessionId/.test(src) && !/body\.session_id/.test(src),
  );
}
check(
  'heartbeat also scopes by owner_id explicitly',
  /\.eq\('owner_id', session\.ownerId\)/.test(heartbeatRoute),
);
check(
  'the events route takes the session from the token, never from the body',
  /session_id: gate\.session\.sessionId/.test(eventsRoute) &&
    !/body\.session_id/.test(eventsRoute),
);
check(
  'the events route still validates every event before inserting any',
  /validatePracticeEvent/.test(eventsRoute) &&
    eventsRoute.indexOf('validatePracticeEvent') < eventsRoute.indexOf("from('practice_events')"),
);

// ── THE LIVEKIT GRANT IS NARROWER THAN THE ADMIN ONE ──
check(
  'the room is derived from the resolved session, not from the request',
  /trainingLiveKitRoom\(gate\.session\.sessionId\)/.test(lkRoute),
);
check(
  'canSubscribe is FALSE — a leaked link cannot be used to watch a session',
  /canSubscribe: false/.test(lkRoute),
);
check('it can publish (that is the point)', /canPublish: true/.test(lkRoute));
check('it cannot publish data', /canPublishData: false/.test(lkRoute));

// ── THE TWO API SURFACES STAY SEPARATE ──
check(
  'the tokenised guard is its own module, not a mode added to the admin guard',
  /requireHostToken/.test(guard) && !/requireTrainingAdmin/.test(guard),
);
check(
  'and it explains why mixing the two would be unsafe',
  /two security paths|two ways in|physically separate/i.test(guard),
);
check(
  'the transport module is the single place that decides which surface is used',
  /mode === 'token'/.test(transport) && /api\/host\//.test(transport),
);
check(
  'the tokenised events body carries NO session_id (it would be an injection point)',
  /eventsBody: \(events\) => \(\{ events \}\)/.test(transport),
);

// ── THE LINK PEOPLE ARE HANDED IS THE ONE THAT NEEDS NO LOGIN ──
check('the QR prefers the tokenised URL', /practiceHostTokenUrl/.test(launcher));
check(
  'and it falls back to the admin URL for pre-token sessions rather than breaking',
  /hostToken\s*\n?\s*\?\s*practiceHostTokenUrl/.test(launcher) ||
    /hostToken *\? *practiceHostTokenUrl/.test(launcher),
);
check(
  'the QR caption tells the operator which kind of link it is',
  /no login needed/.test(launcher) && /login required/.test(launcher),
);

// ── path helpers ──
function hostPath(token) {
  return `/p/${encodeURIComponent(token)}`;
}
check('a token path is under /p/', hostPath('abc').startsWith('/p/'));
check(
  'a token containing URL-significant characters is escaped',
  hostPath('a/b?c=1') === '/p/a%2Fb%3Fc%3D1',
);
check(
  '/p/ cannot shadow existing top-level routes',
  !['/products', '/privacy', '/plans'].some((r) => r.startsWith('/p/')),
);

console.log(`\n${passed} checks passed`);
