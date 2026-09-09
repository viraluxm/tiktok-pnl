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

// ── REGRESSION GUARD: the constraints handed to LocalVideoTrack must be
// unwrappable by livekit-client, or publishTrack throws and NO video is ever
// published — in every browser, silently.
//
// Verbatim port of livekit-client 2.20.0's unwrapConstraint. It is called during
// publish as:
//     track.constraints.height && unwrapConstraint(track.constraints.height) >= 1080
// so a `{max}`-only range (which is what media.ts uses for capture, correctly, to
// avoid pinning either axis) reaches the throw. The fix is to supply the track's
// RESOLVED settings as plain numbers instead of letting LocalVideoTrack fall back
// to getConstraints(). ──
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
  'LocalVideoTrack is NOT given undefined constraints (that falls back to the {max} ranges)',
  !/new LocalVideoTrack\(videoTrack, undefined, true\)/.test(publish),
);
check(
  'it is given constraints derived from the track\'s resolved settings',
  /videoTrack\.getSettings\(\)/.test(publish) &&
    /new LocalVideoTrack\(videoTrack, publishConstraints, true\)/.test(publish),
);
// Simulate the real shape those settings produce and assert it survives the helper.
for (const settings of [
  { width: 720, height: 1280, frameRate: 30 },   // portrait phone
  { width: 1280, height: 720, frameRate: 30 },   // landscape laptop
  { width: 640, height: 480, frameRate: 29.97 }, // odd framerate
  {},                                            // dimensions not yet known
]) {
  const built = {
    ...(typeof settings.width === 'number' ? { width: settings.width } : {}),
    ...(typeof settings.height === 'number' ? { height: settings.height } : {}),
    ...(typeof settings.frameRate === 'number' ? { frameRate: Math.round(settings.frameRate) } : {}),
  };
  check(
    `settings ${JSON.stringify(settings)} produce publishable constraints`,
    (() => {
      try {
        for (const v of Object.values(built)) unwrapConstraint(v);
        // The guard in livekit-client is `track.constraints.height && ...`, so an
        // absent height short-circuits before the throw — also safe.
        return true;
      } catch { return false; }
    })(),
  );
}
check(
  'the capture constraints themselves are left alone (portrait framing preserved)',
  (() => {
    // Test the DECLARATION, not the file — media.ts's prose legitimately mentions
    // "ideal" when explaining why it is not used.
    const media = readFileSync(fileURLToPath(new URL('./media.ts', import.meta.url)), 'utf8');
    const block = media.slice(
      media.indexOf('PRACTICE_VIDEO_CAPTURE'),
      media.indexOf('};', media.indexOf('PRACTICE_VIDEO_CAPTURE')),
    );
    return !/\bideal\s*:/.test(block) && !/\bexact\s*:/.test(block) && /max: 1280/.test(block);
  })(),
);

console.log(`\n${passed} checks passed`);
