/**
 * One normalized response shape for every provider, so client code never
 * changes when providers are added/removed. OpenAI chat.completions-style.
 *
 * Tool-calling aware: when the upstream produced tool_calls (native from
 * OpenAI-compatible providers, converted from functionCall parts for
 * Gemini), they ride along in the message and finish_reason becomes
 * "tool_calls" — exactly what agents like Hermes Agent parse for.
 *
 * `raw` (the provider's original JSON) is only included when
 * GATEWAY_INCLUDE_RAW=1 — keeps production payloads small.
 */

function normalizeResponse({ provider, model, text, usage, raw, tool_calls, finish_reason }) {
  const hasToolCalls = Array.isArray(tool_calls) && tool_calls.length > 0;
  const content = text || "";

  const message = { role: "assistant", content: hasToolCalls && !content ? null : content };
  if (hasToolCalls) message.tool_calls = tool_calls;

  const body = {
    id: `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    provider,
    model: model || "auto",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish_reason || (hasToolCalls ? "tool_calls" : "stop")
      }
    ]
  };

  if (usage) body.usage = usage;
  if (process.env.GATEWAY_INCLUDE_RAW === "1") body.raw = raw;

  return body;
}

module.exports = { normalizeResponse };
