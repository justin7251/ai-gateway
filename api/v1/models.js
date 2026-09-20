/**
 * GET /api/v1/models — OpenAI-style model list for clients that expect it
 * (OpenAI SDKs, Nous Hermes Agent endpoint verification, etc).
 *
 * Lists only providers whose API key is configured. Ids use the gateway's
 * pinned "provider:model" form so clients can pass them straight back as
 * the `model` field and get deterministic routing.
 *
 * Auth: same GATEWAY_SECRET Bearer token.
 */

const { checkAuth } = require("../../lib/auth");
const { setCors } = require("../../lib/http");
const { DEFAULT_MODELS } = require("../../lib/router");

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

  const data = Object.entries(DEFAULT_MODELS)
    .filter(([name]) => process.env[`${name.toUpperCase()}_API_KEY`])
    .map(([name, def]) => ({
      id: `${name}:${process.env[`${name.toUpperCase()}_MODEL`] || def}`,
      object: "model",
      owned_by: name
    }));

  return res.status(200).json({ object: "list", data });
};
