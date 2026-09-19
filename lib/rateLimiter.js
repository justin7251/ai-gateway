/**
 * Per-provider fixed-window rate limit counter.
 *
 * Storage cascade (first available backend wins):
 *   1. Upstash Redis     (UPSTASH_REDIS_REST_URL + TOKEN)
 *   2. SQLite via libSQL (LIBSQL_URL — file: locally, Turso libsql:// in prod)
 *   3. none configured   -> limiter off, fail-open
 *
 * Always fails OPEN: a counter outage must never take the gateway down.
 * Keys look like  ratelimit:<provider>:<windowIndex>  and self-clean.
 */

const WINDOW_SECONDS = Number(process.env.RATE_WINDOW_SECONDS || 60);

let redisClient; // undefined = not initialized yet, false = unavailable

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      redisClient = false;
      return redisClient;
    }
    const { Redis } = require("@upstash/redis");
    redisClient = new Redis({ url, token });
  } catch (err) {
    console.error(`rateLimiter: init failed (${err.message}) — limiter disabled`);
    redisClient = false;
  }
  return redisClient;
}

/**
 * @param {string} provider       provider name, e.g. "gemini"
 * @param {number} maxPerWindow   conservative cap per window (0 disables)
 * @returns {Promise<boolean>}    true = skip this provider right now
 */
async function isRateLimited(provider, maxPerWindow) {
  if (!maxPerWindow || maxPerWindow <= 0) return false;

  // 1) Redis path (preferred when configured)
  const redis = getRedis();
  if (redis) {
    try {
      const key = `ratelimit:${provider}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, WINDOW_SECONDS + 1);
      }
      return count > maxPerWindow;
    } catch (err) {
      console.error(`rateLimiter: redis error (${err.message}) — trying SQLite fallback`);
    }
  }

  // 2) SQLite path (lib/store no-ops to 0 when LIBSQL_URL is unset)
  if (process.env.LIBSQL_URL) {
    try {
      const store = require("./store");
      const count = await store.incrCounter(provider);
      return count > maxPerWindow;
    } catch (err) {
      console.error(`rateLimiter: sqlite error (${err.message}) — failing open`);
    }
  }

  // 3) No backend available -> fail open
  return false;
}

module.exports = { isRateLimited };
