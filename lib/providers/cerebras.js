/**
 * Cerebras adapter (OpenAI-compatible endpoint, free tier).
 *
 * Notes vs the original plan:
 *  - Default model is gpt-oss-120b: Cerebras pruned its free catalog
 *    (2026) and llama3.1-8b is no longer the safe default. Verify the
 *    current catalog at https://inference-docs.cerebras.ai/models/overview
 *    before pinning something else.
 *
 * Agent support: whitelisted params (temperature, tools, ...) pass
 * through; tool_calls in responses are preserved; SSE streaming via
 * streamCerebras(). Cerebras reports usage in the final stream chunk on
 * its own, so no stream_options hint is sent (some strict servers
 * reject unknown fields — fail-safe default).
 */

const { postJson, openStream, openAIBody } = require("../http");

const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

async function callCerebras({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY not configured");

  const chosen = model || process.env.CEREBRAS_MODEL || "gpt-oss-120b";

  const data = await postJson({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params }),
    timeoutMs,
    provider: "cerebras"
  });

  const choice = data && data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const text = msg.content || "";
  const toolCalls = msg.tool_calls;

  if (!text && !(Array.isArray(toolCalls) && toolCalls.length)) {
    throw new Error("cerebras: empty response");
  }

  const u = data && data.usage;
  const usage = u
    ? {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens
      }
    : undefined;

  return {
    text,
    raw: data,
    model: chosen,
    usage,
    tool_calls: Array.isArray(toolCalls) && toolCalls.length ? toolCalls : undefined,
    finish_reason: (choice && choice.finish_reason) || undefined
  };
}

async function streamCerebras({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY not configured");

  const chosen = model || process.env.CEREBRAS_MODEL || "gpt-oss-120b";

  const upstream = await openStream({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params, stream: true, includeUsage: false }),
    connectTimeoutMs: timeoutMs,
    provider: "cerebras"
  });

  return { upstream, model: chosen };
}

module.exports = { callCerebras, streamCerebras };
