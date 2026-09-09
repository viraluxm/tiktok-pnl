/**
 * Retry policy for fetching one slice of a label stack.
 *
 * A slice is up to 60 shipping documents fetched from TikTok inside a single request, so one slow
 * shop can push one window past the gateway timeout while every other window succeeds. Before
 * this, that threw and discarded the whole multi-minute build — it happened twice in one night on
 * a 1,400-label stack and the operator had to start over from nothing both times.
 *
 * Retrying is cheap AND strictly better than restarting: the documents a failed attempt did
 * fetch are cached in the ledger's doc_url, so the second attempt does less work than the first.
 *
 * Kept as plain functions with no imports so the policy is unit-testable without a DOM.
 */

/** Attempts per slice, including the first. */
export const MAX_SLICE_TRIES = 3;

/**
 * Whether an HTTP status is worth trying again.
 *
 * 5xx and 0 (a dropped connection, surfaced as a thrown fetch) are transient by nature. 4xx is a
 * DECISION about this run — 404 no such run, 409 nothing printable, 401 signed out — and repeating
 * it only delays an error the operator needs to read. Retrying a 4xx would have turned tonight's
 * clear "Nothing printable in that run" into a 30-second hang ending in the same message.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * How long to wait before attempt N+1 (1-based attempt that just failed).
 *
 * Growing, because the cause is a slow upstream: retrying instantly tends to hit the same
 * congestion that caused the timeout. Capped so a stack of 24 slices cannot silently sit for
 * minutes — three tries spends at most 11s of waiting per slice.
 */
export function retryWaitMs(attempt: number): number {
  const ladder = [3_000, 8_000];
  return ladder[attempt - 1] ?? ladder[ladder.length - 1];
}

/** Whether another attempt is allowed after `attempt` (1-based) failed with `status`. */
export function shouldRetry(attempt: number, status: number): boolean {
  return attempt < MAX_SLICE_TRIES && isRetryableStatus(status);
}
