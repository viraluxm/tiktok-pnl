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

console.log(`\n${passed} checks passed`);
