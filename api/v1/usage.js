/**
 * GET /api/v1/usage — per-provider usage stats for the last 24h,
 * read from the SQLite request_log (lib/store).
 *
 * Returns { enabled: false } when LIBSQL_URL is not configured.
 * Auth: same GATEWAY_SECRET Bearer token.
 */

const { checkAuth } = require("../../lib/auth");
const { setCors } = require("../../lib/http");
const store = require("../../lib/store");

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.LIBSQL_URL) {
    return res.status(200).json({
      enabled: false,
      note: "Set LIBSQL_URL (file: locally or libsql:// Turso in prod) to enable usage tracking"
    });
  }

  const providers = await store.getUsage(Date.now() - 24 * 3600_000);
  return res.status(200).json({
    enabled: true,
    window: "last_24h",
    providers
  });
};
