import 'server-only';
import { EgressClient } from 'livekit-server-sdk';
import {
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  S3Upload,
} from '@livekit/protocol';

// Practice Mode recording — LiveKit egress configuration, in one place.
//
// WHY TRACK-COMPOSITE AND NOT ROOM-COMPOSITE. Room/web composite renders the page
// in a headless Chrome to burn the overlay into the pixels. We do not need that:
// the overlay is re-rendered at playback from practice_events (migration 142),
// which additionally gives scrubbing, jump-to-auction and queryable timings that a
// flat video cannot. Track-composite muxes the camera and mic tracks with ffmpeg —
// cheaper per minute, and no browser in the recording path.
//
// LiveKit here is LIVEKIT CLOUD (lensed-practice-live-*.livekit.cloud), so egress
// is a managed, metered service — there is no egress container or Redis to run.
// The ceiling is the plan's CONCURRENT EGRESS limit, which surfaces as an
// EGRESS_LIMIT_REACHED status rather than an error on start (see the webhook).

export const RECORDING_BUCKET = 'practice-recordings';

// Feature flag. Unset/false = LOG ONLY: the start route reports the exact egress
// request it WOULD issue and writes nothing, so the whole path can be inspected
// before it bills a single minute or touches storage.
export function isRecordingWriteEnabled(): boolean {
  return process.env.PRACTICE_RECORDING_WRITE_ENABLED === 'true';
}

// Video bitrate in kbps. 1200 kbps at 720x1280 is comfortably enough to judge a
// host's delivery, and roughly halves both storage and upload time against
// LiveKit's default for 720p — at ~100 recordings a day that difference is the
// whole point. Tunable without a deploy.
const DEFAULT_VIDEO_BITRATE_KBPS = 1200;
const DEFAULT_AUDIO_BITRATE_KBPS = 96;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// PORTRAIT, deliberately. Practice hosts hold phones upright, and src/lib/training/
// media.ts already caps capture at a 1280 long edge on both axes for exactly that
// reason. Encoding to 720x1280 keeps the host's real framing; a landscape output
// would letterbox or crop every recording.
export function practiceEncodingOptions(): EncodingOptions {
  return new EncodingOptions({
    width: 720,
    height: 1280,
    framerate: 30,
    videoBitrate: intFromEnv('PRACTICE_RECORDING_VIDEO_KBPS', DEFAULT_VIDEO_BITRATE_KBPS),
    audioBitrate: intFromEnv('PRACTICE_RECORDING_AUDIO_KBPS', DEFAULT_AUDIO_BITRATE_KBPS),
  });
}

// Object key inside the bucket. Session-prefixed so every recording for one
// session (restartPractice can produce several) groups together, and so a
// retention job can delete by prefix.
export function recordingObjectPath(sessionId: string, startedAtMs: number): string {
  return `${sessionId}/${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}.mp4`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration, resolved once and reported honestly.
//
// Every value is required for a recording to land, and a missing one must be
// VISIBLE rather than producing a silent no-op — that is the failure mode the
// existing LiveKit paths have and the one this must not repeat.
export interface RecordingConfig {
  livekitUrl: string;
  livekitHttpUrl: string;
  apiKey: string;
  apiSecret: string;
  s3AccessKey: string;
  s3Secret: string;
  s3Region: string;
  s3Endpoint: string;
}

export type RecordingConfigResult =
  | { ok: true; config: RecordingConfig }
  | { ok: false; missing: string[] };

// Just enough to VERIFY a LiveKit webhook signature. Deliberately separate from
// resolveRecordingConfig: the webhook neither writes to S3 nor starts an egress, it
// verifies a signature and updates a row. Coupling it to the S3 credentials made it
// fail closed for the wrong reason — a forged payload got a config error instead of
// a 401, and the response listed which variables were unset to an unauthenticated
// caller.
export type WebhookConfigResult =
  | { ok: true; apiKey: string; apiSecret: string }
  | { ok: false; missing: string[] };

export function resolveWebhookConfig(): WebhookConfigResult {
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const missing = [
    ...(apiKey ? [] : ['LIVEKIT_API_KEY']),
    ...(apiSecret ? [] : ['LIVEKIT_API_SECRET']),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, apiKey: apiKey as string, apiSecret: apiSecret as string };
}

export function resolveRecordingConfig(): RecordingConfigResult {
  const env = {
    NEXT_PUBLIC_LIVEKIT_URL: process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim(),
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY?.trim(),
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET?.trim(),
    // Supabase Storage speaks the S3 protocol, so egress writes straight into the
    // practice-recordings bucket. These are Storage > S3 Access Keys, minted by
    // hand in the dashboard — the Management API has no endpoint for them.
    SUPABASE_S3_ACCESS_KEY_ID: process.env.SUPABASE_S3_ACCESS_KEY_ID?.trim(),
    SUPABASE_S3_SECRET_ACCESS_KEY: process.env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim(),
  };
  const missing = Object.entries(env)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, missing };

  const url = env.NEXT_PUBLIC_LIVEKIT_URL as string;
  // The server APIs speak https; the client URL is wss.
  const livekitHttpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

  // Derived from the Supabase URL rather than configured separately, so the two
  // can never point at different projects.
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL as string).hostname.split('.')[0];

  return {
    ok: true,
    config: {
      livekitUrl: url,
      livekitHttpUrl,
      apiKey: env.LIVEKIT_API_KEY as string,
      apiSecret: env.LIVEKIT_API_SECRET as string,
      s3AccessKey: env.SUPABASE_S3_ACCESS_KEY_ID as string,
      s3Secret: env.SUPABASE_S3_SECRET_ACCESS_KEY as string,
      s3Region: process.env.SUPABASE_S3_REGION?.trim() || 'us-west-2',
      s3Endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/s3`,
    },
  };
}

// The file output egress writes to. forcePathStyle is REQUIRED for Supabase's S3
// gateway — it does not serve virtual-host-style bucket addressing, and without
// this the upload fails with a DNS error that says nothing about the cause.
export function buildFileOutput(config: RecordingConfig, objectPath: string): EncodedFileOutput {
  return new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: objectPath,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: config.s3AccessKey,
        secret: config.s3Secret,
        region: config.s3Region,
        endpoint: config.s3Endpoint,
        bucket: RECORDING_BUCKET,
        forcePathStyle: true,
      }),
    },
  });
}

export function egressClient(config: RecordingConfig): EgressClient {
  return new EgressClient(config.livekitHttpUrl, config.apiKey, config.apiSecret);
}

// What the log-only mode prints, and what the start route echoes back. Secrets are
// NEVER included — only whether they resolved.
export function describeRecordingPlan(args: {
  sessionId: string;
  room: string;
  objectPath: string;
  videoTrackId: string;
  audioTrackId: string | null;
  config: RecordingConfig;
}) {
  const enc = practiceEncodingOptions();
  return {
    would_start: 'trackCompositeEgress',
    room: args.room,
    session_id: args.sessionId,
    video_track_id: args.videoTrackId,
    audio_track_id: args.audioTrackId,
    output: {
      bucket: RECORDING_BUCKET,
      path: args.objectPath,
      endpoint: args.config.s3Endpoint,
      region: args.config.s3Region,
      force_path_style: true,
      file_type: 'MP4',
    },
    encoding: {
      width: enc.width,
      height: enc.height,
      framerate: enc.framerate,
      video_kbps: enc.videoBitrate,
      audio_kbps: enc.audioBitrate,
      estimated_mb_per_30min: Math.round(
        ((enc.videoBitrate + enc.audioBitrate) * 1000 * 1800) / 8 / 1_000_000,
      ),
    },
    credentials_resolved: true,
  };
}
