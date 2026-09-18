/**
 * Groq adapter (OpenAI-compatible endpoint, free tier).
 *
 * Default model llama-3.1-8b-instant verified current as of 2026-09
 * (free tier ≈ 30 req/min, 14,400 req/day). The router's conservative
 * cap should stay below the published limit.
 *
 * Agent support: whitelisted params (temperature, tools, ...) pass
 * through; tool_calls in responses are preserved; SSE streaming via
 * streamGroq().
 */

const { postJson, openStream, openAIBody } = require("../http");

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

async function callGroq({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const chosen = model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const data = await postJson({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params }),
    timeoutMs,
    provider: "groq"
  });

  const choice = data && data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const text = msg.content || "";
  const toolCalls = msg.tool_calls;

  // An assistant turn that only calls tools has no content — that's fine.
  if (!text && !(Array.isArray(toolCalls) && toolCalls.length)) {
    throw new Error("groq: empty response");
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

async function streamGroq({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");

  const chosen = model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const upstream = await openStream({
    url: ENDPOINT,
    headers: headers(apiKey),
    body: openAIBody({ model: chosen, messages, params, stream: true }),
    connectTimeoutMs: timeoutMs,
    provider: "groq"
  });

  return { upstream, model: chosen };
}

module.exports = { callGroq, streamGroq };
