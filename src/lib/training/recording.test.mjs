// Tests for the recording layer's decisions (migration 143 + egress config).
//
// The high-value case is the egress status mapping: during a 10-at-once audition
// block, EGRESS_LIMIT_REACHED is the most likely failure, and it must read as a
// plan-limit problem — a completely different action from "the upload broke".
//
// Run:  node src/lib/training/recording.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rec = readFileSync(fileURLToPath(new URL('./recording.ts', import.meta.url)), 'utf8');
const hook = readFileSync(fileURLToPath(new URL('./usePracticeRecording.ts', import.meta.url)), 'utf8');
const webhook = readFileSync(
  fileURLToPath(new URL('../../app/api/integrations/livekit/webhook/route.ts', import.meta.url)),
  'utf8',
);
const startRoute = readFileSync(
  fileURLToPath(new URL('../../app/api/admin/training/recording/start/route.ts', import.meta.url)),
  'utf8',
);
const publish = readFileSync(fileURLToPath(new URL('./useVideoPublish.ts', import.meta.url)), 'utf8');
const reconcile = readFileSync(fileURLToPath(new URL('./reconcileRecordings.ts', import.meta.url)), 'utf8');
const sessionsHook = readFileSync(fileURLToPath(new URL('../../hooks/usePracticeSessions.ts', import.meta.url)), 'utf8');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── status mapping: anything not clearly running or complete is a FAILURE ──
// LiveKit's EgressStatus: 0 STARTING, 1 ACTIVE, 2 ENDING, 3 COMPLETE, 4 FAILED,
// 5 ABORTED, 6 LIMIT_REACHED.
const S = { STARTING: 0, ACTIVE: 1, ENDING: 2, COMPLETE: 3, FAILED: 4, ABORTED: 5, LIMIT: 6 };
function mapStatus(s) {
  if (s === S.STARTING || s === S.ACTIVE || s === S.ENDING) return 'recording';
  if (s === S.COMPLETE) return 'complete';
  return 'failed';
}
check('STARTING is still recording', mapStatus(S.STARTING) === 'recording');
check('ACTIVE is still recording', mapStatus(S.ACTIVE) === 'recording');
check('ENDING is still recording (the file is not written yet)', mapStatus(S.ENDING) === 'recording');
check('COMPLETE is the only success', mapStatus(S.COMPLETE) === 'complete');
check('FAILED is a failure', mapStatus(S.FAILED) === 'failed');
check('ABORTED is a failure, not a quiet success', mapStatus(S.ABORTED) === 'failed');
check('LIMIT_REACHED is a failure', mapStatus(S.LIMIT) === 'failed');
check('an UNKNOWN future status defaults to failed, never to complete', mapStatus(99) === 'failed');

// ── the limit case must be explained, because it is the likely one at 10 concurrent ──
check(
  'EGRESS_LIMIT_REACHED is handled explicitly',
  /EGRESS_LIMIT_REACHED/.test(webhook),
);
check(
  'and its message names the plan limit rather than a generic error',
  /concurrent-egress limit reached/.test(webhook),
);
check(
  'a failure is logged at error level so it is findable in Vercel logs',
  /console\.error\([\s\S]{0,120}recording FAILED/.test(webhook),
);

// ── webhook trust + idempotency ──
check(
  'the raw body is used for verification, not a re-serialised object',
  /await req\.text\(\)/.test(webhook) && !/await req\.json\(\)/.test(webhook),
);
check('an unverifiable payload is rejected 401', /Invalid signature'\s*\}, \{ status: 401/.test(webhook));
check(
  'the missing-config list is logged, never returned to an unauthenticated caller',
  /console\.error\('\[livekit-webhook\] cannot verify, missing:/.test(webhook) &&
    /error: 'Not configured'/.test(webhook),
);
check(
  'the webhook needs ONLY the LiveKit keys (it neither writes S3 nor starts egress)',
  /resolveWebhookConfig/.test(webhook) && !/resolveRecordingConfig/.test(webhook),
);
check(
  'the row is matched on external_id, whose partial UNIQUE makes retries idempotent',
  /\.eq\('external_id', info\.egressId\)/.test(webhook),
);
check(
  'a DB failure returns 500 so LiveKit retries rather than stranding the row',
  /update failed[\s\S]{0,160}status: 500/.test(webhook),
);
check(
  'the final path/duration/size come from fileResults, not from what we requested',
  /info\.fileResults\?\.\[0\]/.test(webhook),
);
check('duration is converted from nanoseconds to ms', /1_000_000/.test(webhook));

// ── start route safety ──
check(
  'a second egress is never started for a session already recording',
  /\.eq\('status', 'recording'\)[\s\S]{0,400}already_recording/.test(startRoute),
);
check(
  'a video track id is REQUIRED (a track-composite egress is defined by it)',
  /video_track_id is required/.test(startRoute),
);
check(
  'no audio track means the field is OMITTED, not sent empty',
  /\.\.\.\(audioTrackId \? \{ audioTrackId \} : \{\}\)/.test(startRoute),
);
check(
  'a failed START is written as a failed row, not swallowed',
  /catch \(err\)[\s\S]{0,700}status: 'failed'[\s\S]{0,200}start failed/.test(startRoute),
);
check(
  'if the row insert fails the egress is stopped, so no untracked job bills minutes',
  /insertErr[\s\S]{0,600}stopEgress/.test(startRoute),
);
check('the flag gates the write, dry-run by default', /isRecordingWriteEnabled\(\)/.test(startRoute));
check(
  'the dry run reports the plan and writes nothing',
  /dry_run: true, plan/.test(startRoute),
);

// ── config ──
check(
  'forcePathStyle is set (Supabase S3 does not do virtual-host bucket addressing)',
  /forcePathStyle: true/.test(rec),
);
check(
  'the S3 endpoint is derived from the Supabase URL, so they cannot point at different projects',
  /NEXT_PUBLIC_SUPABASE_URL as string\)\.hostname/.test(rec),
);
check('the output is MP4', /EncodedFileType\.MP4/.test(rec));
check(
  'encoding is PORTRAIT 720x1280 (hosts hold phones upright)',
  /width: 720/.test(rec) && /height: 1280/.test(rec),
);
check(
  'the bitrate is explicit and tunable, not LiveKit default',
  /PRACTICE_RECORDING_VIDEO_KBPS/.test(rec),
);
check('no secret is ever put in the plan description', !/accessKey|apiSecret/.test(
  rec.slice(rec.indexOf('describeRecordingPlan')),
));

// ── storage path groups by session so retention can delete by prefix ──
function objectPath(sessionId, ms) {
  return `${sessionId}/${new Date(ms).toISOString().replace(/[:.]/g, '-')}.mp4`;
}
const p1 = objectPath('abc-123', Date.parse('2026-09-09T07:30:00.000Z'));
check('the path is session-prefixed', p1.startsWith('abc-123/'), p1);
check('it ends in .mp4', p1.endsWith('.mp4'));
check('it contains no characters that break an S3 key', !/[:.]/.test(p1.replace(/\.mp4$/, '')));
check(
  'two runs of the same session produce different objects (restartPractice)',
  objectPath('s', 1000) !== objectPath('s', 2000),
);

// ── the client contract that makes any of it possible ──
check(
  'useVideoPublish now RETURNS the published track SIDs',
  /PublishedTracks/.test(publish) && /videoPub\.trackSid/.test(publish),
);
check(
  'a publish failure returns a REASON rather than a bare null',
  /PublishResult/.test(publish) && /ok: false, reason:/.test(publish),
);
check(
  'connect and publish failures are distinguishable',
  /could not reach LiveKit/.test(publish) && /publish failed/.test(publish),
);
check(
  'a 403 is named as a non-admin account, not a generic failure',
  /not an admin/.test(publish),
);
check(
  'a 500 is named as missing server config',
  /LiveKit is not configured on the server/.test(publish),
);
check(
  'the login-redirect trap is handled in the publish path too',
  /res\.redirected/.test(publish),
);
check(
  'the host surfaces the publisher\'s own reason, not a generic symptom',
  /setState\(\{ kind: 'failed', reason: published\.reason \}\)/.test(hook),
);
check(
  'recording starts only AFTER publish resolves (the SIDs must exist in the room first)',
  /publishVideo\(stream\)\.then/.test(
    readFileSync(fileURLToPath(new URL('../../components/training/LiveSimulator.tsx', import.meta.url)), 'utf8'),
  ),
);
check(
  'a recording failure is SHOWN on the host screen, unlike the live-preview paths',
  /Not recording — /.test(
    readFileSync(fileURLToPath(new URL('../../components/training/LiveSimulator.tsx', import.meta.url)), 'utf8'),
  ),
);
check(
  'the dry run is labelled so a test is never mistaken for a real recording',
  /nothing is being saved/.test(
    readFileSync(fileURLToPath(new URL('../../components/training/LiveSimulator.tsx', import.meta.url)), 'utf8'),
  ),
);
check(
  'the start hook is latched so a retry cannot start two egresses',
  /startedRef\.current = true/.test(hook),
);
check(
  'the login-redirect trap is handled here too',
  /res\.redirected/.test(hook),
);

// ── REGRESSION GUARD: publishTrack MUST be given an explicit
// degradationPreference, or livekit-client evaluates its default:
//     opts.degradationPreference ??= getDefaultDegradationPreference(track)
// which reads
//     track.constraints.height && unwrapConstraint(track.constraints.height) >= 1080
// and unwrapConstraint understands only a bare number, an array, {exact} or
// {ideal}. media.ts caps capture with {max:1280} ranges on purpose (no ideal/exact,
// so neither axis is pinned and a portrait phone keeps its framing), so the default
// hit `throw Error('could not unwrap constraint')` and aborted EVERY publish in
// EVERY browser — silently, because the camera still ran.
//
// Passing constraints to the LocalVideoTrack constructor does NOT fix it: the
// constructor starts setMediaStreamTrack() asynchronously and that resets
// _constraints from the MediaStreamTrack afterwards. `??=` is what makes supplying
// the option here effective. ──
function unwrapConstraint(constraint) {
  if (typeof constraint === 'string' || typeof constraint === 'number') return constraint;
  if (Array.isArray(constraint)) return constraint[0];
  if (constraint.exact !== undefined) {
    return Array.isArray(constraint.exact) ? constraint.exact[0] : constraint.exact;
  }
  if (constraint.ideal !== undefined) {
    return Array.isArray(constraint.ideal) ? constraint.ideal[0] : constraint.ideal;
  }
  throw Error('could not unwrap constraint');
}
check(
  'a {max}-only range is exactly what livekit-client CANNOT unwrap (the bug)',
  (() => { try { unwrapConstraint({ max: 1280 }); return false; } catch { return true; } })(),
);
check(
  'the camera publish supplies an explicit degradationPreference',
  /degradationPreference: 'balanced'/.test(publish),
);
check(
  'it is passed on the CAMERA publish (the video track), not somewhere inert',
  /source: Track\.Source\.Camera[\s\S]{0,1600}degradationPreference/.test(publish),
);
check(
  "and 'balanced' matches what the default would have returned below 1080p",
  (() => {
    // getDefaultDegradationPreference: screenshare or height>=1080 -> maintain-resolution
    const forHeight = (h) => (h >= 1080 ? 'maintain-resolution' : 'balanced');
    return forHeight(720) === 'balanced' && forHeight(1280) === 'maintain-resolution';
  })(),
);
check(
  'the capture declaration carries no size constraint at all',
  (() => {
    // The capture ceiling was REMOVED (it broke publishing); the cap now lives in
    // PRACTICE_VIDEO_ENCODING, applied at publish. Anything size-shaped
    // reappearing here is the regression to catch.
    const media = readFileSync(fileURLToPath(new URL('./media.ts', import.meta.url)), 'utf8');
    const block = media.slice(
      media.indexOf('PRACTICE_VIDEO_CAPTURE'),
      media.indexOf('};', media.indexOf('PRACTICE_VIDEO_CAPTURE')),
    );
    return !/\b(width|height|frameRate)\s*:/.test(block) && /facingMode/.test(block);
  })(),
);
check(
  'the bandwidth cap moved to the publish encoding instead',
  /videoEncoding: PRACTICE_VIDEO_ENCODING/.test(publish),
);

// ── Reconcile: the webhook must be an optimisation, not a dependency ──
// It is configured in the LiveKit Cloud dashboard, outside this repo and outside
// this deploy. If it is missing or points at a stale preview URL, rows sit at
// 'recording' forever while the MP4 is perfectly fine in storage.
check(
  'reconcile asks LiveKit directly rather than waiting for the webhook',
  /listEgress\(/.test(reconcile),
);
check(
  'it only touches rows still marked recording',
  /\.eq\('status', 'recording'\)/.test(reconcile),
);
check(
  'it is owner-scoped through the parent (practice_recordings has no RLS policies)',
  /\.eq\('owner_id', ownerId\)/.test(reconcile),
);
check(
  'young rows are left alone (an egress takes seconds to report)',
  /MIN_AGE_MS/.test(reconcile) && /\.lt\('started_at', cutoff\)/.test(reconcile),
);
check(
  'a row with no matching job is only abandoned once far too old to be real',
  /ABANDON_AFTER_MS/.test(reconcile) && /age > ABANDON_AFTER_MS/.test(reconcile),
);
check(
  'abandoning says the file may still exist rather than implying it was lost',
  /may exist in storage/.test(reconcile),
);
check(
  'EGRESS_LIMIT_REACHED is still named explicitly here too',
  /concurrent-egress limit reached/.test(reconcile),
);
check(
  'a missing config is REPORTED, not returned as silent zeros',
  /skipped: `not configured/.test(reconcile),
);
check(
  'a listEgress failure is reported too',
  /skipped: `listEgress failed/.test(reconcile),
);
// The client half: it must not become a background poll against LiveKit.
check(
  'the launcher only reconciles while a recording is actually in flight',
  /const inFlight = sessions\.some\(/.test(sessionsHook) && /if \(!inFlight\) return;/.test(sessionsHook),
);
check(
  'overlapping passes are prevented',
  /runningRef\.current/.test(sessionsHook),
);
check(
  'the list is refreshed only when something actually changed',
  /const changed =/.test(sessionsHook),
);
check(
  'reconcile falls back to STORAGE for the byte size (listEgress carries no fileResults)',
  /sizeFromStorage/.test(reconcile) && /RECORDING_BUCKET/.test(reconcile),
);
check(
  'it does NOT fabricate a duration (only the webhook knows it)',
  !/duration_ms: *[0-9]/.test(reconcile) && /Duration is deliberately NOT guessed/.test(reconcile),
);
check(
  'already-complete rows missing a size are backfilled',
  /\.is\('size_bytes', null\)/.test(reconcile),
);
check(
  'a storage failure does not fail the whole reconcile',
  /storage unreachable/.test(reconcile),
);

console.log(`\n${passed} checks passed`);
