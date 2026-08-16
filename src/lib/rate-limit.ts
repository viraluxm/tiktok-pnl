// In-memory rate limiter using a Map with TTL-based eviction.
// TODO: Replace with @upstash/ratelimit + Redis before scaling to
// multiple server instances (in-memory state is per-process).

interface RateLimitOptions {
  /** Max number of requests allowed in the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiter({ limit, windowMs }: RateLimitOptions) {
  const cache = new Map<string, RateLimitEntry>();

  // Evict expired entries every 60s to prevent unbounded growth
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.resetAt) cache.delete(key);
    }
  }, 60_000).unref();

  return {
    /** Returns { success: true } if under the limit, { success: false, retryAfterMs } if exceeded. */
    check(key: string): { success: boolean; retryAfterMs?: number } {
      const now = Date.now();
      const entry = cache.get(key);

      if (!entry || now >= entry.resetAt) {
        cache.set(key, { count: 1, resetAt: now + windowMs });
        return { success: true };
      }

      if (entry.count < limit) {
        entry.count++;
        return { success: true };
      }

      return {
        success: false,
        retryAfterMs: entry.resetAt - now,
      };
    },
  };
}

// Pre-configured limiters for common use cases
// Auth: 10 attempts per IP per 15 minutes
export const authLimiter = createRateLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});

// TikTok sync: 120 syncs per user per minute (auto-loop fires every ~500ms)
export const syncLimiter = createRateLimiter({
  limit: 120,
  windowMs: 60 * 1000,
});

// Public scheduling token routes (/s/[token]/*). Two independent limiters — by token and by IP —
// so a single leaked token can't hammer, and a single IP can't spray many tokens. In-memory /
// per-process (see the file header): weak at multi-instance scale, but 32 bytes of token entropy
// carries the real abuse protection here; this just caps accidental / casual hammering.
// Page loads are chattier than mutations, so the read limiter is looser than the write one.
export const scheduleTokenLimiter = createRateLimiter({ limit: 60, windowMs: 60 * 1000 });
export const scheduleIpLimiter = createRateLimiter({ limit: 120, windowMs: 60 * 1000 });
export const scheduleWriteLimiter = createRateLimiter({ limit: 15, windowMs: 60 * 1000 });

// Rotating clock-code issuance (/s/[token]/clock). Keyed per EMPLOYEE and stacked on top of
// guardPublicWrite's token/IP caps — this one exists to catch a stuck client re-requesting a
// nonce in a loop, not to police normal use (a person issues one code per punch).
export const clockCodeLimiter = createRateLimiter({ limit: 4, windowMs: 30 * 1000 });

// Badge kiosk (/api/kiosk/*). Three limiters because the kiosk has three different abuse shapes
// and one shared network identity — every reader in the warehouse exits through ONE IP, so an
// IP-keyed limit alone would punish a normal shift change.
//
// IP: the loose ceiling every kiosk route passes through (scan, employees, window-state polling,
// clock-out, start-break, manual-punch). Sized for the worst LEGITIMATE minute — a whole shift
// badging in at once while the window-state poll runs — not for a single user. 300/min ≈ 5 req/s
// from the building: far above real traffic, still a hard stop on a runaway client or script.
export const kioskIpLimiter = createRateLimiter({ limit: 300, windowMs: 60 * 1000 });

// BADGE: keyed on the badge code, so it survives the shared IP. Deliberately burst-tolerant —
// a re-scan inside 60s is a supported interaction (it returns STATUS), so employees genuinely do
// scan repeatedly, and throttling that would read as a broken reader. 15/min stops a cloned or
// replayed badge from being hammered without ever touching normal use (~4-8 scans/day/badge).
export const kioskBadgeLimiter = createRateLimiter({ limit: 15, windowMs: 60 * 1000 });

// SUPERVISOR: guards a supervisor PASSWORD check (/supervisor-verify, /manual-punch) on a device
// that is physically reachable by anyone in the warehouse — the one true brute-force target here.
// Tighter than authLimiter's 10/15min for exactly that reason: supervisor overrides are rare and
// sensitive, so 5 attempts per 15 minutes per IP costs a legitimate supervisor nothing.
export const kioskSupervisorIpLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
