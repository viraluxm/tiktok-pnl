// Wiring invariants for the Practice Mode P0 capacity/reliability fixes.
//
// WHY THIS FILE EXISTS: three of the four P0 fixes live inside a React component
// or a Next config and cannot be exercised as pure functions without a DOM
// renderer (which this repo does not have). Rather than assert nothing, this
// pins the specific SEMANTIC invariant each fix depends on — the header value,
// the cleanup call inside completePractice, and the shared-constant call sites.
// The pure/behavioural coverage lives in media.test.mjs and session.test.mjs;
// runtime behaviour is covered by the manual device checklist.
//
// Run:  node src/lib/training/practiceModeWiring.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const nextConfig = read('../../../next.config.ts');
const liveSimulator = read('../../components/training/LiveSimulator.tsx');
const trainerVideo = read('../../components/training/TrainerVideoView.tsx');
const videoPublish = read('./useVideoPublish.ts');
const launcher = read('../../components/training/PracticeModeLauncher.tsx');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// Extract a top-level function body from a component file (2-space indented
// `function name() { ... \n  }`), so we assert on the real body, not the file.
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `could not find function ${name}`);
  const open = src.indexOf('{', start);
  const end = src.indexOf('\n  }', open);
  assert.ok(end !== -1, `could not delimit function ${name}`);
  return src.slice(open, end);
}

// ── P0-1: microphone must be allowed same-origin only ──
const policy = (nextConfig.match(/"Permissions-Policy",\s*\n?\s*value:\s*"([^"]+)"/) || [])[1];
check('Permissions-Policy header is present', typeof policy === 'string', policy);
check('microphone is allowed same-origin', policy.includes('microphone=(self)'));
check('microphone is NOT disabled', !policy.includes('microphone=()'));
check('microphone is NOT delegated to * or a third party', !/microphone=\(\s*\*/.test(policy));
check('camera stays same-origin', policy.includes('camera=(self)'));
check('geolocation stays disabled', policy.includes('geolocation=()'));

// ── P0-3: shared media policy is actually used at every call site ──
check(
  'host capture uses the shared PRACTICE_VIDEO_CAPTURE',
  (liveSimulator.match(/video: PRACTICE_VIDEO_CAPTURE/g) || []).length === 2,
  'both the audio:true and audio:false getUserMedia calls',
);
check(
  'no inline facingMode literal remains in host capture',
  !/video:\s*\{\s*facingMode/.test(liveSimulator),
);
check('host Room uses shared options', videoPublish.includes('new Room(PRACTICE_ROOM_OPTIONS)'));
check('controller Room uses shared options', trainerVideo.includes('new Room(PRACTICE_ROOM_OPTIONS)'));
check(
  'no bare new Room() anywhere (would silently restore the slow defaults)',
  !/new Room\(\s*\)/.test(videoPublish) && !/new Room\(\s*\)/.test(trainerVideo),
);

// ── P0-1b: controller must not auto-play host audio ──
check(
  'controller attaches host audio to its OWN element',
  /track\.attach\(audioRef\.current\)/.test(trainerVideo),
);
check(
  'controller re-mutes right after attach (attach sets muted=false internally)',
  /audioRef\.current\.muted = !hostAudioOnRef\.current/.test(trainerVideo),
);
check(
  'no bare track.attach() for audio (would create an unmuted off-DOM element)',
  !/\btrack\.attach\(\s*\)/.test(trainerVideo),
);
check('audio element ships muted by default', /<audio[^>]*\smuted/.test(trainerVideo));
check('host audio defaults to OFF', /useState\(false\)/.test(trainerVideo));
check(
  'enabling audio is user-gesture driven (click handler)',
  /onClick=\{\(\) => void toggleHostAudio\(\)\}/.test(trainerVideo),
);
check(
  'enabling audio unlocks autoplay via startAudio()',
  /startAudio\(\)/.test(trainerVideo),
);
check(
  'video stays muted (audio never rides on the video element)',
  /<video[\s\S]{0,160}?muted/.test(trainerVideo),
);

// ── P0-4: natural completion releases camera + mic + LiveKit ──
const complete = functionBody(liveSimulator, 'completePractice');
check('completePractice calls the canonical stopStream()', /\bstopStream\(\)/.test(complete));
check(
  'completePractice still broadcasts the complete phase',
  /broadcastSessionState\('complete'\)/.test(complete),
);
check(
  'completePractice still stops its timers',
  /stopSessionTimers\(\)/.test(complete) && /stopAuctionTimers\(\)/.test(complete),
);
const stopStreamBody = functionBody(liveSimulator, 'stopStream');
check(
  'stopStream stops every local track (camera AND mic)',
  /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(stopStreamBody),
);
check(
  'stopStream tears down the LiveKit publish',
  /stopVideo\(\)/.test(stopStreamBody),
);
check(
  'stopStream is idempotent (nulls the stream ref after stopping)',
  /streamRef\.current = null/.test(stopStreamBody),
);
check(
  'unmount cleanup still calls stopStream (guards not regressed)',
  /mountedRef\.current = false;[\s\S]{0,400}?stopStream\(\)/.test(liveSimulator),
);
check(
  'the mounted guard before starting media is still present',
  /if \(!mountedRef\.current\)/.test(liveSimulator),
);

// ── P0-2: launcher must not truncate ──
check('MAX_RECENT is gone from the launcher', !/MAX_RECENT/.test(launcher));
check(
  'no destructive slice(0, N) truncation remains',
  !/\.slice\(0,\s*\w+\)/.test(launcher),
);
check(
  'launcher uses the shared non-destructive list helpers',
  /parseLauncherSessions/.test(launcher) &&
    /addLauncherSession/.test(launcher) &&
    /removeLauncherSession/.test(launcher),
);
check('manual Remove is still wired', /removeSession\(id\)/.test(launcher));

console.log(`\n${passed} checks passed`);
