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
const controlClient = read('../../components/training/ControlClient.tsx');
const trainerEventsSrc = read('../../components/training/trainerEvents.ts');
const deleteRoute = read('../../app/api/admin/training/sessions/[id]/route.ts');
const logHook = read('./usePracticeLog.ts');
const eventsRoute = read('../../app/api/admin/training/events/route.ts');

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
// P0-2's concern was that the launcher's localStorage array was the ONLY record of
// a session id, so truncating it would strand a running practice live. That record
// now lives in practice_sessions (migration 136), which is shared across machines
// and survives a cache clear — a strictly stronger guarantee than a non-destructive
// local list. The assertions below therefore pin the NEW mechanism, and in
// particular the one ordering that could still lose an id: the legacy list must be
// IMPORTED before it is deleted.
check(
  'the launcher reads sessions from the registry, not from localStorage',
  /usePracticeSessions\(\)/.test(launcher),
);
check(
  'the legacy localStorage key is only ever READ and REMOVED, never written',
  /getItem\(LEGACY_STORAGE_KEY\)/.test(launcher) &&
    /removeItem\(LEGACY_STORAGE_KEY\)/.test(launcher) &&
    !/setItem\(LEGACY_STORAGE_KEY/.test(launcher),
);
check(
  'legacy ids are imported BEFORE the key is deleted (never the reverse)',
  launcher.indexOf('mutateAsync({ id })') < launcher.indexOf('removeItem(LEGACY_STORAGE_KEY)'),
);
check(
  'the launcher still truncates nothing',
  !/\.slice\(0,\s*\w+\)/.test(launcher),
);
check(
  'discard is still wired for unused sessions',
  /onDiscard=\{\(\) => remove\.mutate\(s\.id\)\}/.test(launcher),
);
// ── A session that RAN must be un-deletable: it owns its recording and event
// timeline (Deploys 3/4), so deleting it would silently shed the replay. Enforced
// in BOTH places — no button, and a route that refuses if called directly. ──
check(
  'the discard button is offered only when started_at is null',
  /session\.started_at === null &&[\s\S]{0,600}onDiscard/.test(launcher),
);
check(
  'the DELETE route itself refuses a session that has started',
  /\.is\('started_at', null\)/.test(deleteRoute),
);
check(
  'a refused delete explains itself rather than 404-ing',
  /already run and is kept in history/.test(deleteRoute),
);
check(
  'finished sessions are listed in History, not deleted',
  /function SessionHistory/.test(launcher) && /ended_at !== null/.test(launcher),
);
check(
  'active and history are split on ended_at (a session cannot be in both)',
  /ended_at === null/.test(launcher) && /ended_at !== null/.test(launcher),
);
check(
  'the training/audition toggle is gone from the launcher',
  !/purpose/.test(launcher),
);

// ── P0-3: the CSP must name the LiveKit origin, DERIVED not hard-coded ──
//
// LiveKit is self-hosted, so its wss host differs per environment. The header is
// built from NEXT_PUBLIC_LIVEKIT_URL at build time. These assertions pin the two
// security-relevant properties of that derivation: it accepts ONLY ws:/wss: (so a
// malformed env value cannot inject a source expression or a whole directive),
// and it fails OPEN to today's header when the var is unset (so a LiveKit-less
// deploy is byte-identical to what ships now).
check(
  'a livekitConnectSrc() deriver exists',
  /function livekitConnectSrc\(\)/.test(nextConfig),
);
check(
  'it reads NEXT_PUBLIC_LIVEKIT_URL rather than a hard-coded host',
  /process\.env\.NEXT_PUBLIC_LIVEKIT_URL/.test(nextConfig) &&
    !/wss:\/\/[a-z0-9-]+\./i.test(nextConfig),
);
check(
  'only ws:/wss: are accepted',
  /protocol !== "wss:" && protocol !== "ws:"/.test(nextConfig),
);
check(
  'an unset/unparseable value returns the empty string (fail open)',
  (nextConfig.match(/return "";/g) || []).length >= 2,
);
check(
  'the derived source is concatenated into connect-src',
  /connect-src[^"]*tiktok-shops\.com" \+\s*\n?\s*livekitConnectSrc\(\)/.test(nextConfig),
);

// ── P0-4: a missing microphone must be VISIBLE on both screens ──
//
// Practice ran silently for a long time because the audio:false fallback in
// startPractice was reached without anything reporting it. The header is fixed,
// but a denied prompt or a mic-less device still lands in that same fallback —
// and an audio track is a hard precondition for track-composite recording.
const startPractice = functionBody(liveSimulator, 'startPractice');
check(
  'the host derives micMissing from the acquired audio tracks',
  /getAudioTracks\(\)\.length === 0/.test(startPractice),
);
check(
  'it is derived AFTER acquisition, so it covers both getUserMedia paths',
  startPractice.indexOf('getAudioTracks().length === 0') >
    startPractice.lastIndexOf('audio: false'),
);
check(
  'the host renders a no-microphone warning',
  /micMissing &&/.test(liveSimulator) && /No microphone/.test(liveSimulator),
);
check(
  'the warning cannot swallow taps on the overlay beneath it',
  /micMissing &&[\s\S]{0,400}pointer-events-none/.test(liveSimulator),
);
check(
  'micMissing is mirrored to the controller on the existing sessionState tick',
  /micMissing: micMissingRef\.current/.test(liveSimulator),
);
check(
  'the broadcast reads a ref, not state, inside the tick closure',
  /const micMissingRef = useRef\(false\)/.test(liveSimulator),
);
check(
  'sessionState carries micMissing as OPTIONAL (old host tabs still type-check)',
  /micMissing\?: boolean/.test(trainerEventsSrc),
);
check(
  'the controller treats only an explicit true as missing, never undefined',
  /event\.micMissing === true/.test(controlClient),
);
check(
  'the controller surfaces it to management',
  /Host has no microphone/.test(controlClient),
);

// ── P0-5: the event timeline must record OUTCOMES, at the right moments ──
//
// The overlay is DOM, not part of the video track, so replay re-renders it from
// this log. That only works if the log says what the screen DID — not what the
// controller asked for. These pin the emit points where the host decides an
// outcome; a log built from commands would replay comments that were suppressed
// and bids whose totals it cannot know.
const addComment = functionBody(liveSimulator, 'addComment');
check(
  'a comment is logged AFTER the blocked-user check, so suppressed comments are never logged',
  addComment.indexOf("blockedRef.current.has(username)") <
    addComment.indexOf("practiceLog.event('comment'"),
);
const placeBid = functionBody(liveSimulator, 'placeBid');
check(
  'a bid logs the resulting TOTAL, not just the command',
  /practiceLog\.event\('bid', \{[^}]*total: auctionBidRef\.current/.test(placeBid),
);
const endAuction = functionBody(liveSimulator, 'endAuction');
check(
  'auction_end reads the winner from a REF, not state (it runs in a timer closure)',
  /winner: auctionWinnerRef\.current/.test(endAuction),
);
check(
  'the winner ref exists so that read cannot be stale',
  /const auctionWinnerRef = useRef<string \| null>\(null\)/.test(liveSimulator),
);
const startRuntime = functionBody(liveSimulator, 'startRuntime');
check(
  'practiceLog.start() runs BEFORE the first viewers emit (it sets the offset epoch)',
  startRuntime.indexOf('practiceLog.start()') < startRuntime.indexOf('updateViewers()'),
);
const completePractice = functionBody(liveSimulator, 'completePractice');
check('the timeline is closed on a clean finish', /practiceLog\.finish\(\)/.test(completePractice));
check(
  'every logged kind is emitted from the host',
  ['comment', 'bid', 'auction_start', 'auction_end', 'auction_reset', 'block', 'viewers']
    .every((k) => new RegExp(`practiceLog\\.event\\('${k}'`).test(liveSimulator)),
);

// ── the log must not lose events on a blip, and must not retry forever ──
check(
  'a 5xx or network failure REQUEUES the batch rather than dropping it',
  /res\.status >= 500\) bufferRef\.current\.requeue\(batch\)/.test(logHook) &&
    /catch \{\s*\n\s*bufferRef\.current\.requeue\(batch\)/.test(logHook),
);
check(
  'a 4xx is NOT requeued (it would block every later event behind it forever)',
  /res\.status >= 500/.test(logHook),
);
check(
  'flushes are serialised so a slow request cannot post the same batch twice',
  /if \(flushingRef\.current\) return;/.test(logHook),
);
check(
  'the final flush uses sendBeacon with an explicit application\/json Blob',
  /sendBeacon/.test(logHook) && /type: 'application\/json'/.test(logHook),
);
check(
  'a refused beacon requeues rather than silently losing the tail',
  /!navigator\.sendBeacon[\s\S]{0,120}requeue\(batch\)/.test(logHook),
);

// ── the events route is the enforcer ──
check(
  'the events route validates EVERY event before inserting ANY (no partial timeline)',
  /for \(const \[i, event\] of body\.events\.entries\(\)\)/.test(eventsRoute) &&
    eventsRoute.indexOf('validatePracticeEvent') < eventsRoute.indexOf(".from('practice_events')"),
);
check(
  'the events route confirms the session belongs to this owner before writing',
  eventsRoute.indexOf(".eq('owner_id', gate.ownerId)") < eventsRoute.indexOf(".from('practice_events')"),
);
check('the events route caps the batch size', /PRACTICE_LOG_MAX_BATCH/.test(eventsRoute));

console.log(`\n${passed} checks passed`);
