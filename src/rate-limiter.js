/**
 * Token-bucket limiter, keyed by caller (client IP) or by widget.
 *
 * A fixed window would keep a blocked caller locked out until the whole window rolls over,
 * which also punishes the ordinary visitor who happens to arrive right after a burst. A
 * bucket refills continuously instead: after a burst the caller is throttled, `Retry-After`
 * says exactly how long until one more request is allowed (a few seconds at the default
 * settings), and a different caller is never affected.
 *
 * Capacity is `max`; the bucket refills `max` tokens per `windowMs`. Buckets are pruned so
 * the map cannot grow without bound.
 */
export function createRateLimiter({ windowMs, max, now = () => Date.now(), maxBuckets = 10_000 }) {
  const buckets = new Map();
  const refillPerMs = max / windowMs;

  function prune() {
    for (const [key, bucket] of buckets) {
      if (bucket.tokens >= max && now() - bucket.updatedAt > windowMs) buckets.delete(key);
    }
    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  return {
    consume(key) {
      const time = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxBuckets) prune();
        bucket = { tokens: max, updatedAt: time };
      } else {
        const elapsed = Math.max(0, time - bucket.updatedAt);
        bucket.tokens = Math.min(max, bucket.tokens + elapsed * refillPerMs);
        bucket.updatedAt = time;
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);
        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          retryAfterSeconds: 0,
        };
      }

      buckets.set(key, bucket);
      const msUntilNextToken = (1 - bucket.tokens) / refillPerMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(msUntilNextToken / 1000)),
      };
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}
