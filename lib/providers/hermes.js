/**
 * Nous Research Hermes adapter.
 *
 * Nous serves its Hermes family (Hermes 4 70B / 405B, DeepHermes 3 ...)
 * through an OpenAI-compatible portal API; keys come from the Nous
 * Portal dashboard. Hermes models are ALSO reachable through OpenRouter
 * (e.g. nousresearch/hermes-4-70b) if you'd rather keep one aggregator
 * key — set OPENROUTER_MODEL accordingly instead of using this adapter.
 *
 * NOTE: verify the exact model ID in your Nous Portal model list before
 * pinning something else; default below is Hermes 4 70B.
 */

const { postJson } = require("../http");

function getEndpoint() {
  const base = process.env.HERMES_BASE_URL || "https://inference-api.nousresearch.com/v1";
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

async function callHermes({ messages, model, timeoutMs }) {
  const apiKey = process.env.HERMES_API_KEY;
  if (!apiKey) throw new Error("HERMES_API_KEY not configured");

  const chosen = model || process.env.HERMES_MODEL || "Hermes-4-70B";

  const data = await postJson({
    url: getEndpoint(),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: { model: chosen, messages },
    timeoutMs,
    provider: "hermes"
  });

  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  if (!text) throw new Error("hermes: empty response");

  const u = data && data.usage;
  const usage = u
    ? {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens
      }
    : undefined;

  return { text, raw: data, model: chosen, usage };
}

module.exports = { callHermes };
