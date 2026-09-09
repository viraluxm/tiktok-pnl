import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EgressStatus } from '@livekit/protocol';
import { egressClient, resolveRecordingConfig } from '@/lib/training/recording';

// Fills in recordings that the webhook never completed.
//
// WHY THIS EXISTS RATHER THAN TRUSTING THE WEBHOOK. Egress is asynchronous, so a
// row's final status, duration and byte size only arrive with the `egress_ended`
// webhook. That webhook is configured in the LiveKit Cloud dashboard — outside this
// repo, outside this deploy, and (here) in an account the team does not administer
// day to day. If it is missing, misconfigured, or points at a stale preview URL,
// every row sits at status='recording' forever while the MP4 sits perfectly fine in
// storage. On a 100-recording day that is the difference between glancing at a list
// and opening a storage browser to count files by hand.
//
// LiveKit exposes exactly the same information on demand via listEgress(), so this
// reconciles from the authoritative source and makes the webhook an optimisation
// instead of a dependency. It is idempotent and safe to call repeatedly.

// Rows younger than this are left alone: an egress genuinely takes a few seconds to
// report, and "recording" is the correct state during that window. Reconciling too
// eagerly would mark a healthy in-flight job as stale.
const MIN_AGE_MS = 20_000;

// Beyond this, a row still marked 'recording' with no matching egress job is not
// coming back — LiveKit has forgotten it. Better to say so than to leave a row
// claiming to be recording days later.
const ABANDON_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

export interface ReconcileResult {
  checked: number;
  completed: number;
  failed: number;
  abandoned: number;
  stillRunning: number;
  skipped?: string;
}

function mapStatus(status: EgressStatus | undefined): 'recording' | 'complete' | 'failed' {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
    case EgressStatus.EGRESS_ACTIVE:
    case EgressStatus.EGRESS_ENDING:
      return 'recording';
    case EgressStatus.EGRESS_COMPLETE:
      return 'complete';
    default:
      return 'failed';
  }
}

function describeFailure(status: EgressStatus | undefined, error: string | undefined): string {
  if (status === EgressStatus.EGRESS_LIMIT_REACHED) {
    return 'LiveKit concurrent-egress limit reached — this recording never started. Raise the plan limit or run fewer simultaneous sessions.';
  }
  if (status === EgressStatus.EGRESS_ABORTED) return `Egress aborted${error ? `: ${error}` : ''}`;
  return error || 'Egress failed without a reason';
}

export async function reconcileRecordings(
  admin: SupabaseClient,
  ownerId: string,
): Promise<ReconcileResult> {
  const empty: ReconcileResult = {
    checked: 0,
    completed: 0,
    failed: 0,
    abandoned: 0,
    stillRunning: 0,
  };

  // Only this owner's in-flight rows. Scoped through the parent because
  // practice_recordings has RLS with no policies.
  const { data: sessions } = await admin
    .from('practice_sessions')
    .select('id')
    .eq('owner_id', ownerId);
  const sessionIds = (sessions ?? []).map((s) => s.id as string);
  if (sessionIds.length === 0) return empty;

  const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
  const { data: rows } = await admin
    .from('practice_recordings')
    .select('id, external_id, started_at')
    .eq('status', 'recording')
    .in('session_id', sessionIds)
    .lt('started_at', cutoff);

  const inFlight = rows ?? [];
  if (inFlight.length === 0) return empty;

  const config = resolveRecordingConfig();
  if (!config.ok) {
    // Cannot ask LiveKit anything. Report it rather than silently returning zeros,
    // which would look like "nothing to do".
    return { ...empty, checked: inFlight.length, skipped: `not configured: ${config.missing.join(', ')}` };
  }

  let jobs;
  try {
    jobs = await egressClient(config.config).listEgress({});
  } catch (err) {
    return {
      ...empty,
      checked: inFlight.length,
      skipped: `listEgress failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const byId = new Map(jobs.map((j) => [j.egressId, j]));

  const result: ReconcileResult = { ...empty, checked: inFlight.length };

  for (const row of inFlight) {
    const job = row.external_id ? byId.get(row.external_id) : undefined;

    if (!job) {
      // No such egress. Either LiveKit has aged it out of its list, or it never
      // existed. Only give up once it is far too old to be real.
      const age = Date.now() - Date.parse(row.started_at as string);
      if (age > ABANDON_AFTER_MS) {
        await admin
          .from('practice_recordings')
          .update({
            status: 'failed',
            error:
              'No matching egress job at LiveKit and too old to still be running. The file may exist in storage — check the bucket before assuming it was lost.',
            ended_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        result.abandoned++;
      } else {
        result.stillRunning++;
      }
      continue;
    }

    const status = mapStatus(job.status);
    if (status === 'recording') {
      result.stillRunning++;
      continue;
    }

    const file = job.fileResults?.[0];
    const patch: Record<string, unknown> = { status, ended_at: new Date().toISOString() };
    if (status === 'failed') patch.error = describeFailure(job.status, job.error).slice(0, 2000);
    if (file?.filename) patch.storage_path = file.filename;
    if (file?.duration) patch.duration_ms = Math.round(Number(file.duration) / 1_000_000);
    if (file?.size) patch.size_bytes = Number(file.size);

    await admin.from('practice_recordings').update(patch).eq('id', row.id);
    if (status === 'complete') result.completed++;
    else result.failed++;
  }

  return result;
}
