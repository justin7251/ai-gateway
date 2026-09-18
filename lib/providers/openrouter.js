/**
 * OpenRouter adapter (aggregator; :free-suffixed models cost nothing).
 *
 * Notes vs the original plan:
 *  - Default model is now openrouter/free, the Free Models Router
 *    (released 2026-02): it auto-picks any currently-live free model.
 *    Individual :free model IDs churn constantly, so pinning one
 *    (e.g. meta-llama/llama-3.1-8b-instruct:free) rots fast. You can
 *    still pin a specific ID via OPENROUTER_MODEL or "openrouter:<id>".
 *  - Sends optional X-Title / HTTP-Referer attribution headers that
 *    OpenRouter asks for.
 *
 * Agent support: whitelisted params (temperature, tools, ...) pass
 * through; tool_calls in responses are preserved; SSE streaming via
 * streamOpenRouter(). Hermes-family models remain reachable here, e.g.
 * OPENROUTER_MODEL=nousresearch/hermes-4-70b.
 */

const { postJson, openStream, openAIBody } = require("../http");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function headers(apiKey) {
  const h = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Title": "personal-ai-gateway"
  };
  if (process.env.OPENROUTER_SITE_URL) {
    h["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }
  return h;
}

async function callOpenRouter({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const chosen = model || process.env.OPENROUTER_MODEL || "openrouter/free";

  const data = await postJson({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params }),
    timeoutMs,
    provider: "openrouter"
  });

  const choice = data && data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const text = msg.content || "";
  const toolCalls = msg.tool_calls;

  if (!text && !(Array.isArray(toolCalls) && toolCalls.length)) {
    throw new Error("openrouter: empty response");
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

async function streamOpenRouter({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const chosen = model || process.env.OPENROUTER_MODEL || "openrouter/free";

  const upstream = await openStream({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params, stream: true }),
    connectTimeoutMs: timeoutMs,
    provider: "openrouter"
  });

  return { upstream, model: chosen };
}

module.exports = { callOpenRouter, streamOpenRouter };
