// Unit proof for Practice Mode session-isolation helpers
// (feat/training-concurrent-practice-sessions).
//
// No app test runner exists, so this transpiles session.ts at runtime via the
// repo's `typescript` devDep (matching src/lib/employees.payperiod.test.mjs) and
// exercises the REAL isValidTrainingSessionId / trainingRealtimeChannel /
// trainingLiveKitRoom / trainingStorageKey / shortTrainingSessionLabel.
//
// Run:  node src/lib/training/session.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const srcPath = fileURLToPath(new URL('./session.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const outFile = join(mkdtempSync(join(tmpdir(), 'tsess-')), 'session.mjs');
writeFileSync(outFile, outputText);
const {
  isValidTrainingSessionId,
  trainingRealtimeChannel,
  trainingLiveKitRoom,
  trainingStorageKey,
  shortTrainingSessionLabel,
  trainingHostPath,
  trainingControllerPath,
  trainingHostUrl,
  trainingControllerUrl,
  parseLauncherSessions,
  addLauncherSession,
  removeLauncherSession,
} = await import(pathToFileURL(outFile).href);

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Two real UUIDs (as crypto.randomUUID() would produce).
const A = 'abc12345-1111-4111-8111-111111111111';
const B = 'xyz00000-2222-4222-9222-222222222222'.replace(/[xyz]/g, 'd'); // keep hex-valid

// ── Validation: accept UUIDs, fail closed on everything else ──
check('accepts a valid v4 UUID', isValidTrainingSessionId(A));
check('rejects missing (undefined)', !isValidTrainingSessionId(undefined));
check('rejects null', !isValidTrainingSessionId(null));
check('rejects empty string', !isValidTrainingSessionId(''));
check('rejects whitespace', !isValidTrainingSessionId('   '));
check('rejects the old shared default', !isValidTrainingSessionId('live-simulator-default'));
check('rejects an arbitrary string', !isValidTrainingSessionId('../../etc/passwd'));
check('rejects a non-string', !isValidTrainingSessionId(12345));

// ── Realtime channel names differ per session (isolation) ──
check('realtime channel is prefixed', trainingRealtimeChannel(A) === `trainer:${A}`);
check(
  'realtime channels differ for different sessions',
  trainingRealtimeChannel(A) !== trainingRealtimeChannel(B),
);

// ── LiveKit room names differ per session, and use a distinct namespace ──
check('livekit room is prefixed', trainingLiveKitRoom(A) === `training:${A}`);
check(
  'livekit rooms differ for different sessions',
  trainingLiveKitRoom(A) !== trainingLiveKitRoom(B),
);
check(
  'livekit room namespace differs from realtime channel',
  trainingLiveKitRoom(A) !== trainingRealtimeChannel(A),
);

// ── Storage keys are session-scoped (two tabs can't clobber each other) ──
check(
  'storage key is namespaced by session',
  trainingStorageKey(A, 'timer') === `training:${A}:timer`,
);
check(
  'storage keys differ across sessions for the same logical key',
  trainingStorageKey(A, 'timer') !== trainingStorageKey(B, 'timer'),
);

// ── Short label ──
check('short label is first 8 chars', shortTrainingSessionLabel(A) === 'abc12345');

// ── Cross-session isolation, end to end: an event "addressed" to session A's
// channel is never delivered to a listener on session B's channel, because the
// derived channel/room names never collide. (No Supabase mock exists in-repo, so
// we prove the naming invariant the isolation relies on.) ──
const routingKey = (id) => `${trainingRealtimeChannel(id)}|${trainingLiveKitRoom(id)}`;
check('session A and B route to fully disjoint names', routingKey(A) !== routingKey(B));

// ── Practice Mode link builders: the QR code and "Copy Host Link" must always
// resolve to the SAME host URL, and the host route must never be confused with
// the controller route. ──
const ORIGIN = 'https://www.lensed.io';
const HOST_ROUTE = '/admin/training/live-simulator';
const CTRL_ROUTE = '/admin/training/live-simulator/control';

// 1. Host URL contains the expected route.
check('host path is the live-simulator route', trainingHostPath(A) === `${HOST_ROUTE}?session=${A}`);
check(
  'absolute host URL is origin + host route',
  trainingHostUrl(ORIGIN, A) === `${ORIGIN}${HOST_ROUTE}?session=${A}`,
);
check(
  'host URL honours the caller origin (no hard-coded domain)',
  trainingHostUrl('https://preview.example.com', A) ===
    `https://preview.example.com${HOST_ROUTE}?session=${A}`,
);

// 2. The correct session UUID is present, and each session gets its own URL.
check('host URL carries the exact session UUID', trainingHostUrl(ORIGIN, A).endsWith(`?session=${A}`));
check('different sessions produce different host URLs', trainingHostUrl(ORIGIN, A) !== trainingHostUrl(ORIGIN, B));
check(
  'host URL is deterministic for a restored session id',
  trainingHostUrl(ORIGIN, A) === trainingHostUrl(ORIGIN, A),
);

// 3. Host and controller routes cannot be confused.
check('controller path is the control route', trainingControllerPath(A) === `${CTRL_ROUTE}?session=${A}`);
check(
  'host URL is NOT the controller URL',
  trainingHostUrl(ORIGIN, A) !== trainingControllerUrl(ORIGIN, A),
);
check(
  'host URL does not contain the /control segment',
  !trainingHostUrl(ORIGIN, A).includes('/live-simulator/control'),
);
check(
  'controller URL does contain the /control segment',
  trainingControllerUrl(ORIGIN, A).includes('/live-simulator/control'),
);

// 4. The value handed to QR generation is the SAME string exposed by Copy Host
// Link. Both call sites in PracticeModeLauncher.tsx go through trainingHostUrl,
// so one builder proves both; assert the launcher really has no second builder.
const launcherSrc = readFileSync(
  fileURLToPath(new URL('../../components/training/PracticeModeLauncher.tsx', import.meta.url)),
  'utf8',
);
check(
  'QR generation encodes trainingHostUrl(...)',
  /QRCode\.toString\(\s*url/.test(launcherSrc) &&
    /const url = trainingHostUrl\(window\.location\.origin, sessionId\)/.test(launcherSrc),
);
check(
  'Copy Host Link copies trainingHostUrl(...)',
  /copyLink\(`host:\$\{id\}`, trainingHostUrl\(window\.location\.origin, id\)\)/.test(launcherSrc),
);
check(
  'launcher builds no second/local host URL implementation',
  !/function\s+hostPath|function\s+withSession|function\s+absoluteUrl/.test(launcherSrc),
);
check('no host URL is hard-coded in the launcher', !/https?:\/\//.test(launcherSrc));

// 5. Creating a session no longer opens/navigates to the host page.
check('launcher never calls window.open', !/window\.open\s*\(/.test(launcherSrc));
check(
  'launcher performs no router navigation',
  !/useRouter|router\.(push|replace)|location\.href\s*=/.test(launcherSrc),
);

// ── Launcher session index (P0-2): the list is the ONLY record of a session id,
// so it must NEVER silently truncate. A dropped id = a running practice live with
// a published camera that can no longer be re-opened, re-QR'd or removed. ──
const uuidAt = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const buildList = (count) => {
  let list = [];
  for (let i = 1; i <= count; i++) list = addLauncherSession(list, uuidAt(i));
  return list;
};

for (const n of [20, 25, 32, 40]) {
  const list = buildList(n);
  check(`creating ${n} sessions retains all ${n}`, list.length === n, `got ${list.length}`);
  check(
    `session #1 survives after ${n} creations`,
    list.includes(uuidAt(1)),
    'the audit’s data-loss bug',
  );
  check(`session #${n} is present after ${n} creations`, list.includes(uuidAt(n)));
  check(`newest-first ordering holds at ${n}`, list[0] === uuidAt(n));
  check(`no id is lost at ${n}`, new Set(list).size === n);
}

// Explicitly pin the old failure mode: the 9th create must not evict the 1st.
const nine = buildList(9);
check('the 9th create does NOT evict the 1st (old MAX_RECENT=8 bug)', nine.length === 9 && nine.includes(uuidAt(1)));

// Reload restoration: persist -> parse round-trip keeps every id and its order.
const forty = buildList(40);
const restored = parseLauncherSessions(JSON.stringify(forty));
check('reload restores all 40 ids', restored.length === 40);
check('reload preserves exact order', restored.every((id, i) => id === forty[i]));
check('reload keeps session #1', restored.includes(uuidAt(1)));

// Legacy compatibility: a previously-capped 8-item array still loads.
const legacy = parseLauncherSessions(JSON.stringify(buildList(8)));
check('legacy 8-item stored array still loads', legacy.length === 8);

// Robustness of the parser.
check('null storage -> empty list', parseLauncherSessions(null).length === 0);
check('malformed JSON -> empty list', parseLauncherSessions('{not json').length === 0);
check('non-array JSON -> empty list', parseLauncherSessions('{"a":1}').length === 0);
check(
  'junk entries are dropped, valid ones kept',
  parseLauncherSessions(JSON.stringify([A, 'nope', 42, null, B])).length === 2,
);
check(
  'duplicates collapse on load',
  parseLauncherSessions(JSON.stringify([A, A, B])).length === 2,
);

// Add is non-destructive and de-duplicating.
check('re-adding an existing id does not duplicate it', addLauncherSession([A, B], A).length === 2);
check('re-adding moves it to the front', addLauncherSession([A, B], B)[0] === B);
check('an invalid id is never added', addLauncherSession([A], 'not-a-uuid').length === 1);

// Remove deletes ONLY the requested id.
const big = buildList(32);
const afterRemove = removeLauncherSession(big, uuidAt(16));
check('remove drops exactly one id', afterRemove.length === 31);
check('remove drops the requested id', !afterRemove.includes(uuidAt(16)));
check('remove keeps session #1', afterRemove.includes(uuidAt(1)));
check('remove keeps session #32', afterRemove.includes(uuidAt(32)));
check(
  'removing an absent id changes nothing',
  removeLauncherSession(big, uuidAt(999)).length === 32,
);

console.log(`\n${passed} checks passed`);
