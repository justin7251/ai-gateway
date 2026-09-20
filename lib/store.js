/**
 * SQLite storage layer via libSQL (@libsql/client).
 *
 * Why SQLite here: serverless disks are ephemeral, so plain file-based
 * SQLite can't persist on Vercel. libSQL is SQLite with pluggable
 * transports — SAME driver, two modes:
 *
 *   Local dev:   LIBSQL_URL="file:data/gateway.db"      (plain file)
 *   Vercel prod: LIBSQL_URL="libsql://you.turso.io"     (Turso free tier,
 *                LIBSQL_AUTH_TOKEN="..."                hosted SQLite over HTTP)
 *
 * With no LIBSQL_URL the store is a no-op — the gateway runs fine with
 * no storage at all (same philosophy as the optional Redis limiter).
 *
 * What it stores (metadata only, never message contents):
 *   request_log    one row per routed request: provider, model, status,
 *                  latency, token usage, error text
 *   rate_counters  fixed-window per-provider counters (used by the
 *                  rate limiter when Redis is not configured)
 */

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 30);
const WINDOW_SECONDS = Number(process.env.RATE_WINDOW_SECONDS || 60);

let clientInstance; // undefined = uninitialized, false = unavailable, object = client
let initPromise;

function getClient() {
  if (clientInstance !== undefined) return clientInstance;

  const url = process.env.LIBSQL_URL;
  if (!url) {
    clientInstance = false;
    return clientInstance;
  }

  try {
    const { createClient } = require("@libsql/client");
    const cfg = { url };
    if (process.env.LIBSQL_AUTH_TOKEN) cfg.authToken = process.env.LIBSQL_AUTH_TOKEN;
    clientInstance = createClient(cfg);

    initPromise = ensureSchema(clientInstance).catch((err) => {
      console.error(`store: schema init failed (${err.message}) — storage disabled`);
      clientInstance = false;
    });
  } catch (err) {
    console.error(`store: init failed (${err.message}) — storage disabled`);
    clientInstance = false;
  }

  return clientInstance;
}

async function ensureSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      error TEXT
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS rate_counters (
      provider TEXT NOT NULL,
      window INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, window)
    )
  `);
}

/**
 * Metadata-only request log. Never throws — logging must not break routing.
 * @param {object} entry { provider, model, status, latency_ms, usage?, error? }
 */
async function logRequest(entry) {
  const db = getClient();
  if (!db) return;
  try {
    await initPromise;
    if (!clientInstance) return;

    const u = entry.usage || {};
    await db.execute({
      sql: `INSERT INTO request_log
              (ts, provider, model, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Date.now(),
        entry.provider || "unknown",
        entry.model || null,
        entry.status || "ok",
        entry.latency_ms ?? null,
        u.prompt_tokens ?? null,
        u.completion_tokens ?? null,
        u.total_tokens ?? null,
        entry.error ? String(entry.error).slice(0, 500) : null
      ]
    });

    // Cheap housekeeping: drop stale rate windows on every write...
    await db.execute({
      sql: `DELETE FROM rate_counters WHERE window < ?`,
      args: [Math.floor(Date.now() / 1000 / WINDOW_SECONDS) - 5]
    });
    // ...and prune old logs ~1% of writes (keeps the free tier lean).
    if (Math.random() < 0.01) {
      await db.execute({
        sql: `DELETE FROM request_log WHERE ts < ?`,
        args: [Date.now() - RETENTION_DAYS * 86400_000]
      });
    }
  } catch (err) {
    console.error(`store: logRequest failed (${err.message})`);
  }
}

/**
 * Atomic fixed-window counter for the rate limiter (SQLite path).
 * @returns {Promise<number>} current count in the active window
 */
async function incrCounter(provider) {
  const db = getClient();
  if (!db) return 0;
  try {
    await initPromise;
    if (!clientInstance) return 0;

    const win = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    try {
      const res = await db.execute({
        sql: `INSERT INTO rate_counters (provider, window, count) VALUES (?, ?, 1)
              ON CONFLICT(provider, window) DO UPDATE SET count = count + 1
              RETURNING count`,
        args: [provider, win]
      });
      return Number(res.rows[0] && res.rows[0].count) || 1;
    } catch (_err) {
      // Older backends without RETURNING: upsert, then read.
      await db.execute({
        sql: `INSERT INTO rate_counters (provider, window, count) VALUES (?, ?, 1)
              ON CONFLICT(provider, window) DO UPDATE SET count = count + 1`,
        args: [provider, win]
      });
      const res = await db.execute({
        sql: `SELECT count FROM rate_counters WHERE provider = ? AND window = ?`,
        args: [provider, win]
      });
      return Number(res.rows[0] && res.rows[0].count) || 1;
    }
  } catch (err) {
    console.error(`store: incrCounter failed (${err.message})`);
    return 0;
  }
}

/**
 * Aggregated usage since a timestamp, grouped by provider.
 * @returns {Promise<object>} { gemini: { requests, errors, avg_latency_ms, tokens... }, ... }
 */
async function getUsage(sinceTs) {
  const db = getClient();
  if (!db) return {};
  try {
    await initPromise;
    if (!clientInstance) return {};

    const res = await db.execute({
      sql: `SELECT provider, status, COUNT(*) AS n,
                   AVG(latency_ms) AS avg_latency,
                   SUM(prompt_tokens) AS prompt_tokens,
                   SUM(completion_tokens) AS completion_tokens,
                   SUM(total_tokens) AS total_tokens
            FROM request_log WHERE ts > ?
            GROUP BY provider, status`,
      args: [sinceTs]
    });

    const out = {};
    for (const row of res.rows) {
      const p = (out[row.provider] = out[row.provider] || {
        requests: 0,
        errors: 0,
        avg_latency_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });
      const n = Number(row.n) || 0;
      p.requests += n;
      if (row.status === "error") p.errors += n;
      p.avg_latency_ms = Math.round(Number(row.avg_latency) || 0);
      p.prompt_tokens += Number(row.prompt_tokens) || 0;
      p.completion_tokens += Number(row.completion_tokens) || 0;
      p.total_tokens += Number(row.total_tokens) || 0;
    }
    return out;
  } catch (err) {
    console.error(`store: getUsage failed (${err.message})`);
    return {};
  }
}

module.exports = { logRequest, incrCounter, getUsage };
