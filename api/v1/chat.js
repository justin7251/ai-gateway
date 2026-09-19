/**
 * POST /api/v1/chat — the single endpoint every client talks to.
 * (OpenAI-SDK-compatible aliases: /api/v1/chat/completions, /v1/*)
 *
 * Pipeline: CORS -> method check -> auth -> validation -> router ->
 * normalize/SSE-pipe -> response. Provider keys and message bodies are
 * never logged — only metadata goes to the SQLite store.
 *
 * Supports the full OpenAI wire contract agents rely on:
 *  - `stream: true` -> SSE chat.completion.chunk events (fallback still
 *    works until the first byte is committed)
 *  - tools / tool_choice passthrough, tool_calls in responses
 *  - temperature / top_p / max_tokens / stop passthrough
 *  - content as string, parts array, or null (tool-call turns)
 */

const { checkAuth } = require("../../lib/auth");
const { routeRequest, routeRequestStream } = require("../../lib/router");
const { normalizeResponse } = require("../../lib/normalize");
const { setCors } = require("../../lib/http");
const { pipeOpenAIStream, pipeGeminiStream } = require("../../lib/streaming");
const store = require("../../lib/store");

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const { messages, model } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // OpenAI wire format: content is a string, an array of parts, or null
  // (assistant turns that only carry tool_calls have null content).
  const wellFormed = messages.every(
    (m) =>
      m &&
      typeof m.role === "string" &&
      (typeof m.content === "string" || Array.isArray(m.content) || m.content === null)
  );
  if (!wellFormed) {
    return res.status(400).json({
      error: "each message must be an object with: role, content (string | array | null)"
    });
  }

  const params = {};
  for (const k of ["temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice"]) {
    if (body[k] !== undefined) params[k] = body[k];
  }
  const hasParams = Object.keys(params).length > 0;

  const startedAt = Date.now();

  // ── Streaming (SSE) ────────────────────────────────────────────────────
  if (body.stream === true) {
    try {
      const { provider, upstream, model: chosenModel } = await routeRequestStream({
        messages,
        model,
        params: hasParams ? params : undefined
      });

      const pipe = provider === "gemini" ? pipeGeminiStream : pipeOpenAIStream;
      const stats = await pipe({ upstream, res, provider, model: chosenModel });

      // Metadata-only usage log; never breaks the response.
      await store.logRequest({
        provider,
        model: chosenModel,
        status: stats.interrupted ? "error" : "ok",
        latency_ms: Date.now() - startedAt,
        usage: stats.usage
      });
      return; // response already written and ended
    } catch (err) {
      // Failed BEFORE the first byte was streamed -> plain JSON error.
      console.error("Gateway stream error:", err.message, JSON.stringify(err.details || null));
      await store.logRequest({
        provider: "none",
        model: typeof model === "string" && model ? model : null,
        status: "error",
        latency_ms: Date.now() - startedAt,
        error: err.message
      });
      return res.status(502).json({
        error: err.message || "All providers failed",
        details: err.details || undefined
      });
    }
  }

  // ── Non-streaming ──────────────────────────────────────────────────────
  try {
    const result = await routeRequest({
      messages,
      model,
      params: hasParams ? params : undefined
    });

    // Metadata-only usage log (no message contents; no-op without LIBSQL_URL)
    await store.logRequest({
      provider: result.provider,
      model: result.model,
      status: "ok",
      latency_ms: Date.now() - startedAt,
      usage: result.usage
    });

    const normalized = normalizeResponse({
      provider: result.provider,
      model: result.model, // actual model that answered (better than "auto")
      text: result.text,
      usage: result.usage,
      raw: result.raw,
      tool_calls: result.tool_calls,
      finish_reason: result.finish_reason
    });

    return res.status(200).json(normalized);
  } catch (err) {
    // Log the message + which providers failed; never the request bodies.
    console.error("Gateway error:", err.message, JSON.stringify(err.details || null));

    await store.logRequest({
      provider: "none",
      model: typeof model === "string" && model ? model : null,
      status: "error",
      latency_ms: Date.now() - startedAt,
      error: err.message
    });

    return res.status(502).json({
      error: err.message || "All providers failed",
      details: err.details || undefined
    });
  }
};
