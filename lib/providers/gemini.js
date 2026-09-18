/**
 * Google Gemini adapter (AI Studio free tier).
 *
 * Notes vs the original plan:
 *  - Default model is gemini-2.5-flash: gemini-1.5-flash is retired (2026).
 *  - API key travels in the x-goog-api-key HEADER, not in the URL query —
 *    keeps the key out of access logs and error dumps.
 *  - System messages are mapped to systemInstruction instead of being
 *    flattened into one "role: content" prompt; assistant role maps to
 *    Gemini's "model" role, so multi-turn conversations keep their shape.
 *  - Empty candidates (safety block) throw, so the router falls through
 *    to the next provider instead of returning an empty answer.
 *
 * Agent support (OpenAI <-> Gemini translation):
 *  - tools (OpenAI function definitions)  -> tools.functionDeclarations
 *    (JSON schemas uppercased to Gemini's Type enum)
 *  - tool_choice                          -> toolConfig.functionCallingConfig
 *  - assistant messages with tool_calls   -> model role + functionCall parts
 *  - role:"tool" result messages          -> functionResponse parts
 *    (the function NAME is resolved from the matching tool_call_id, which
 *    Gemini requires but OpenAI messages don't carry)
 *  - functionCall parts in responses      -> OpenAI tool_calls
 *  - streaming via streamGemini(): alt=sse upstream, converted to OpenAI
 *    chunks by lib/streaming.js
 */

const { postJson, openStream } = require("../http");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// ── OpenAI -> Gemini request mapping ─────────────────────────────────────

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI content parts: keep text, ignore non-text (image) parts.
    return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

function parseToolArgs(raw) {
  if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : {};
  try {
    return JSON.parse(raw) || {};
  } catch (_) {
    return { _raw: String(raw) };
  }
}

/** JSON Schema -> Gemini schema (Type enum values are UPPERCASE). */
function jsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.format) out.format = schema.format;
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = jsonSchemaToGemini(v) || {};
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = jsonSchemaToGemini(schema.items);
  if (schema.nullable !== undefined) out.nullable = schema.nullable;
  return out;
}

function toolsToGemini(tools) {
  const decls = [];
  for (const t of tools || []) {
    const fn = t && (t.function || t); // accept OpenAI {type,function} or bare form
    if (!fn || !fn.name) continue;
    decls.push({
      name: fn.name,
      description: fn.description || "",
      parameters: jsonSchemaToGemini(fn.parameters)
    });
  }
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

function toolConfigToGemini(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof toolChoice === "object" && toolChoice.function && toolChoice.function.name) {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.function.name] } };
  }
  return undefined;
}

/**
 * OpenAI messages (+ whitelisted params) -> Gemini generateContent payload.
 * Exported for tests.
 */
function buildPayload(messages, params = {}) {
  const contents = [];
  const systemParts = [];

  // tool_call_id -> function name, so role:"tool" results can name themselves
  const toolNameById = new Map();
  for (const m of messages) {
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id && tc.function && tc.function.name) {
          toolNameById.set(tc.id, tc.function.name);
        }
      }
    }
  }

  for (const m of messages) {
    if (!m) continue;

    if (m.role === "system") {
      const t = textOf(m.content);
      if (t.trim()) systemParts.push(t);
      continue;
    }

    if (m.role === "tool") {
      const name = toolNameById.get(m.tool_call_id) || m.tool_call_id || "function";
      let response;
      if (typeof m.content === "string") {
        try {
          response = JSON.parse(m.content);
        } catch (_) {
          response = { result: m.content };
        }
      } else if (m.content == null) {
        response = { result: "" };
      } else {
        response = m.content;
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }]
      });
      continue;
    }

    const parts = [];
    const t = textOf(m.content);
    if (t) parts.push({ text: t });
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.function && tc.function.name) {
          parts.push({
            functionCall: { name: tc.function.name, args: parseToolArgs(tc.function.arguments) }
          });
        }
      }
    }
    if (parts.length) {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }

  const payload = { contents };
  if (systemParts.length) {
    payload.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }

  const genCfg = {};
  if (params.temperature !== undefined) genCfg.temperature = params.temperature;
  if (params.top_p !== undefined) genCfg.topP = params.top_p;
  if (params.max_tokens !== undefined) genCfg.maxOutputTokens = params.max_tokens;
  if (Object.keys(genCfg).length) payload.generationConfig = genCfg;

  const tools = toolsToGemini(params.tools);
  if (tools) payload.tools = tools;
  const toolCfg = toolConfigToGemini(params.tool_choice);
  if (toolCfg) payload.toolConfig = toolCfg;

  return payload;
}

// ── Gemini -> OpenAI response mapping ────────────────────────────────────

function mapFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

// ── Adapters ─────────────────────────────────────────────────────────────

async function callGemini({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const chosen = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const data = await postJson({
    url: `${ENDPOINT}/${encodeURIComponent(chosen)}:generateContent`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: buildPayload(messages, params),
    timeoutMs,
    provider: "gemini"
  });

  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text).filter(Boolean).join("");
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: {
        name: p.functionCall.name || "",
        arguments: JSON.stringify(p.functionCall.args || {})
      }
    }));

  if (!text && !toolCalls.length) {
    const reason =
      (candidate && candidate.finishReason) ||
      (data && data.promptFeedback && data.promptFeedback.blockReason) ||
      "empty response";
    throw new Error(`gemini: ${reason}`);
  }

  const um = data.usageMetadata;
  const usage = um
    ? {
        prompt_tokens: um.promptTokenCount,
        completion_tokens: um.candidatesTokenCount,
        total_tokens: um.totalTokenCount
      }
    : undefined;

  return {
    text,
    raw: data,
    model: chosen,
    usage,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: mapFinishReason(candidate && candidate.finishReason, toolCalls.length > 0)
  };
}

async function streamGemini({ messages, model, timeoutMs, params }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const chosen = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const upstream = await openStream({
    url: `${ENDPOINT}/${encodeURIComponent(chosen)}:streamGenerateContent?alt=sse`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: buildPayload(messages, params),
    connectTimeoutMs: timeoutMs,
    provider: "gemini"
  });

  return { upstream, model: chosen };
}

module.exports = { callGemini, streamGemini, buildPayload };
