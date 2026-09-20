/**
 * POST /api/v1/chat/completions — OpenAI-SDK-compatible alias for chat.js.
 *
 * Same handler, same auth, same normalized (OpenAI-style) response. This
 * path exists so tools that hardcode the OpenAI wire format — notably
 * Nous Hermes Agent, which POSTs /v1/chat/completions and probes
 * GET /v1/models — can point directly at the gateway:
 *
 *   base_url: https://<your-app>.vercel.app/api/v1
 *   api_key:  <GATEWAY_SECRET>
 */

module.exports = require("../chat.js");
