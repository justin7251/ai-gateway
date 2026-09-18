/**
 * Router with ordered fallback — text AND streaming paths.
 *
 * Order in PROVIDERS = priority. For each request it walks the list and:
 *  1. skips providers with no API key configured (start with just one key!)
 *  2. skips providers currently over their conservative rate cap
 *  3. calls the adapter with a timeout clamped to the global budget
 *  4. falls through to the next provider on ANY failure
 *
 * Model routing semantics (improvement over the plan, which shipped one
 * global `model` that most providers would reject):
 *  - model omitted or "auto"  -> each provider uses its own default
 *  - model "groq:llama-3.1-8b-instant" -> PIN to that provider + model
 *  - model "llama-3.1-8b-instant"      -> literal pass-through; providers
 *    that don't know the model fail fast and the router falls through
 *
 * Streaming: routeRequestStream() walks the same list but only needs the
 * upstream to OPEN successfully (status + headers). A provider that fails
 * before its first byte is streamed is skipped like any other failure;
 * after that the stream is committed (no mid-stream fallback possible).
 *
 * Params: agents (Hermes Agent, OpenAI SDKs) may send temperature, tools,
 * tool_choice, etc. A strict whitelist is forwarded; everything else is
 * dropped, never passed upstream blindly.
 */

const { callGemini, streamGemini } = require("./providers/gemini");
const { callGroq, streamGroq } = require("./providers/groq");
const { callOpenRouter, streamOpenRouter } = require("./providers/openrouter");
const { callCerebras, streamCerebras } = require("./providers/cerebras");
const { isRateLimited } = require("./rateLimiter");

const PROVIDERS = [
  { name: "gemini", fn: callGemini, streamFn: streamGemini, envKey: "GEMINI_API_KEY", maxPerWindow: Number(process.env.GEMINI_MAX_RPM || 10) },
  { name: "groq", fn: callGroq, streamFn: streamGroq, envKey: "GROQ_API_KEY", maxPerWindow: Number(process.env.GROQ_MAX_RPM || 25) },
  { name: "openrouter", fn: callOpenRouter, streamFn: streamOpenRouter, envKey: "OPENROUTER_API_KEY", maxPerWindow: Number(process.env.OPENROUTER_MAX_RPM || 15) },
  { name: "cerebras", fn: callCerebras, streamFn: streamCerebras, envKey: "CEREBRAS_API_KEY", maxPerWindow: Number(process.env.CEREBRAS_MAX_RPM || 25) }
];

// Default model per provider — also used by GET /api/v1/models to build
// the OpenAI-style model list (pinned "provider:model" ids).
const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  groq: "llama-3.1-8b-instant",
  openrouter: "openrouter/free",
  cerebras: "gpt-oss-120b"
};

const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 8000);
const BUDGET_MS = Number(process.env.GATEWAY_BUDGET_MS || 28000);
const MIN_HOP_MS = 500;

const PARAM_KEYS = ["temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice"];

function pickParams(params) {
  if (!params) return undefined;
  const out = {};
  for (const k of PARAM_KEYS) {
    if (params[k] !== undefined) out[k] = params[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function resolveTarget(model) {
  const requested =
    model && String(model).trim() !== "" && String(model).trim() !== "auto"
      ? String(model).trim()
      : undefined;

  // "provider:model" pinning
  let pinned = null;
  let passthrough = requested;
  if (requested) {
    const idx = requested.indexOf(":");
    if (idx > 0) {
      const head = requested.slice(0, idx).toLowerCase();
      if (PROVIDERS.some((p) => p.name === head)) {
        pinned = head;
        passthrough = requested.slice(idx + 1) || undefined;
      }
    }
  }
  return { pinned, passthrough };
}

function fail(pinned, errors) {
  const combined = pinned
    ? new Error(`Pinned provider '${pinned}' failed`)
    : new Error("All providers failed or rate limited");
  combined.details = errors;
  throw combined;
}

async function routeRequest({ messages, model, params } = {}) {
  const { pinned, passthrough } = resolveTarget(model);
  const cleanParams = pickParams(params);
  const errors = [];
  const deadline = Date.now() + BUDGET_MS;

  for (const provider of PROVIDERS) {
    if (pinned && provider.name !== pinned) continue;

    if (!process.env[provider.envKey]) {
      errors.push(`${provider.name}: skipped (no ${provider.envKey} configured)`);
      continue;
    }

    if (Date.now() >= deadline) {
      errors.push(`${provider.name}: skipped (gateway time budget exhausted)`);
      break;
    }

    try {
      const limited = await isRateLimited(provider.name, provider.maxPerWindow);
      if (limited) {
        errors.push(`${provider.name}: rate limited (skipped)`);
        continue;
      }

      const timeoutMs = Math.max(MIN_HOP_MS, Math.min(PROVIDER_TIMEOUT_MS, deadline - Date.now()));
      const result = await provider.fn({ messages, model: passthrough, timeoutMs, params: cleanParams });
      return { provider: provider.name, ...result };
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      continue; // try next provider
    }
  }

  fail(pinned, errors);
}

/**
 * Open a streaming upstream from the first healthy provider.
 * @returns {{ provider: string, upstream: Response, model: string }}
 */
async function routeRequestStream({ messages, model, params } = {}) {
  const { pinned, passthrough } = resolveTarget(model);
  const cleanParams = pickParams(params);
  const errors = [];
  const deadline = Date.now() + BUDGET_MS;

  for (const provider of PROVIDERS) {
    if (pinned && provider.name !== pinned) continue;

    if (!process.env[provider.envKey]) {
      errors.push(`${provider.name}: skipped (no ${provider.envKey} configured)`);
      continue;
    }

    if (Date.now() >= deadline) {
      errors.push(`${provider.name}: skipped (gateway time budget exhausted)`);
      break;
    }

    try {
      const limited = await isRateLimited(provider.name, provider.maxPerWindow);
      if (limited) {
        errors.push(`${provider.name}: rate limited (skipped)`);
        continue;
      }

      const timeoutMs = Math.max(MIN_HOP_MS, Math.min(PROVIDER_TIMEOUT_MS, deadline - Date.now()));
      const opened = await provider.streamFn({ messages, model: passthrough, timeoutMs, params: cleanParams });
      return { provider: provider.name, upstream: opened.upstream, model: opened.model };
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      continue; // upstream never opened -> safe to fall through
    }
  }

  fail(pinned, errors);
}

module.exports = { routeRequest, routeRequestStream, DEFAULT_MODELS };
