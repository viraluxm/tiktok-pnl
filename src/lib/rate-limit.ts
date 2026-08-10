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
