import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { EgressStatus } from '@livekit/protocol';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveWebhookConfig } from '@/lib/training/recording';

export const runtime = 'nodejs'; // signature verification needs Node crypto
export const dynamic = 'force-dynamic';

// POST /api/integrations/livekit/webhook — LiveKit egress lifecycle events.
//
// WHY THIS IS REQUIRED, NOT OPTIONAL. Starting an egress is asynchronous: the final
// object path, duration and byte size are only known when it ENDS. Without this
// route every recording would sit at status='recording' forever, and a reviewer
// could not tell a finished recording from a failed one.
//
// It lives under /api/integrations/* because that prefix is already excluded from
// the middleware matcher (src/middleware.ts) — a cookieless server-to-server call
// must not be 307'd to /login. No matcher change was needed.
//
// AUTH IS THE SIGNATURE, NOT A SESSION. LiveKit signs the body and puts a JWT in
// the Authorization header; WebhookReceiver verifies it against the API
// key/secret. An unsigned or mis-signed body is rejected — this endpoint is public
// and must never trust its input.

// Maps LiveKit's egress status onto our three-state column. Anything that is not
// clearly still running or cleanly complete is a FAILURE, and says so.
function mapStatus(status: EgressStatus | undefined): 'recording' | 'complete' | 'failed' {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
    case EgressStatus.EGRESS_ACTIVE:
    case EgressStatus.EGRESS_ENDING:
      return 'recording';
    case EgressStatus.EGRESS_COMPLETE:
      return 'complete';
    default:
      // EGRESS_FAILED, EGRESS_ABORTED, EGRESS_LIMIT_REACHED, or unknown.
      return 'failed';
  }
}

// Human-readable reason, so History can explain a failure instead of showing a
// blank. EGRESS_LIMIT_REACHED is called out explicitly because it is the one that
// will appear if concurrent recordings exceed the LiveKit plan's limit — during a
// 10-at-once audition block that is the single most likely failure, and "the plan
// limit was hit" is a completely different action from "the upload broke".
function describeFailure(info: { status?: EgressStatus; error?: string }): string {
  if (info.status === EgressStatus.EGRESS_LIMIT_REACHED) {
    return 'LiveKit concurrent-egress limit reached — this recording never started. Raise the plan limit or run fewer simultaneous sessions.';
  }
  if (info.status === EgressStatus.EGRESS_ABORTED) {
    return `Egress aborted${info.error ? `: ${info.error}` : ''}`;
  }
  return info.error || 'Egress failed without a reason';
}

export async function POST(req: Request) {
  // Only the LiveKit key/secret — this route does not touch S3 and must not fail
  // because storage credentials are unset.
  const config = resolveWebhookConfig();
  if (!config.ok) {
    // 500 (not 200) so LiveKit retries once configuration is fixed rather than
    // dropping the event. The missing names are LOGGED, never returned: this
    // endpoint is public and unauthenticated callers get nothing back.
    console.error('[livekit-webhook] cannot verify, missing:', config.missing.join(', '));
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  // The RAW body is what was signed — it must be read as text and not re-serialised.
  const raw = await req.text();
  const authHeader = req.headers.get('Authorization') ?? undefined;

  let event;
  try {
    event = await new WebhookReceiver(config.apiKey, config.apiSecret).receive(
      raw,
      authHeader,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[livekit-webhook] rejected unverified payload:', message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const info = event.egressInfo;
  // Room/participant events also arrive here; only egress ones concern us. 200 so
  // LiveKit does not retry something we deliberately ignore.
  if (!info?.egressId) {
    return NextResponse.json({ ok: true, ignored: event.event });
  }

  const status = mapStatus(info.status);
  // fileResults carries the authoritative final location, duration and size —
  // the request's filepath is only what we ASKED for.
  const file = info.fileResults?.[0];

  const patch: Record<string, unknown> = { status };
  if (status === 'failed') patch.error = describeFailure(info).slice(0, 2000);
  if (status !== 'recording') patch.ended_at = new Date().toISOString();
  if (file?.location || file?.filename) {
    // `location` is a full URL; store the object key so a signed URL can be minted
    // later without re-parsing a vendor URL shape.
    patch.storage_path = file.filename || file.location;
  }
  // duration is nanoseconds (protobuf int64 -> bigint), size is bytes.
  if (file?.duration) patch.duration_ms = Math.round(Number(file.duration) / 1_000_000);
  if (file?.size) patch.size_bytes = Number(file.size);

  const admin = createAdminClient();
  // Keyed on external_id, whose partial UNIQUE index makes a retried webhook
  // idempotent — LiveKit retries are normal and must not duplicate or conflict.
  const { data, error } = await admin
    .from('practice_recordings')
    .update(patch)
    .eq('external_id', info.egressId)
    .select('id, session_id')
    .maybeSingle();

  if (error) {
    // 500 so LiveKit retries — losing the terminal event would strand the row.
    console.error('[livekit-webhook] update failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    // An egress we never recorded (e.g. started outside this app, or the insert
    // failed after the start). Acknowledge so it is not retried forever.
    console.warn('[livekit-webhook] no practice_recordings row for egress', info.egressId);
    return NextResponse.json({ ok: true, unmatched: info.egressId });
  }

  if (status === 'failed') {
    console.error(
      `[livekit-webhook] recording FAILED for session ${data.session_id}: ${patch.error}`,
    );
  }
  return NextResponse.json({ ok: true, recording_id: data.id, status });
}
