/**
 * Shared HTTP helper for all provider adapters.
 *
 * Uses Node 18+ native fetch (no node-fetch dependency) with a hard
 * AbortController timeout per request. This is what makes fallback fast:
 * a hanging provider can never consume the whole function budget.
 */

class ApiError extends Error {
  constructor(message, { status = 0, provider = "", bodySnippet = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.provider = provider;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * POST JSON, expect JSON back.
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.headers
 * @param {object} opts.body        - will be JSON.stringify-ed
 * @param {number} opts.timeoutMs   - hard timeout for this single call
 * @param {string} [opts.provider]  - label used in error messages
 * @returns {Promise<object>} parsed JSON response
 */
async function postJson({ url, headers, body, timeoutMs, provider = "" }) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ApiError(`timeout after ${timeoutMs}ms`, { status: 408, provider });
    }
    throw new ApiError(`network error: ${err.message}`, { status: 0, provider });
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw_text: String(text).slice(0, 2000) };
  }

  if (!res.ok) {
    const snippet =
      (data && (data.error?.message || data.error?.message_ || data.message)) ||
      (typeof data?.raw_text === "string" ? data.raw_text : "") ||
      "";
    throw new ApiError(`HTTP ${res.status}${snippet ? `: ${String(snippet).slice(0, 200)}` : ""}`, {
      status: res.status,
      provider,
      bodySnippet: String(snippet).slice(0, 500)
    });
  }

  return data;
}

/**
 * Open an SSE streaming upstream connection (for `stream: true`).
 *
 * The abort timer covers CONNECT time only (status + headers); once the
 * response is OK the timer is cleared so long streams aren't killed
 * mid-answer — Vercel's maxDuration still caps the total stream length.
 * Throws ApiError on connect failure so the router can fall through.
 */
async function openStream({ url, headers, body, connectTimeoutMs, provider = "" }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), connectTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ApiError(`connect timeout after ${connectTimeoutMs}ms`, { status: 408, provider });
    }
    throw new ApiError(`network error: ${err.message}`, { status: 0, provider });
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    let snippet = "";
    try {
      snippet = String(await res.text()).slice(0, 500);
    } catch (_) {}
    throw new ApiError(
      `HTTP ${res.status}${snippet ? `: ${snippet.slice(0, 200)}` : " (no stream body)"}`,
      { status: res.status, provider, bodySnippet: snippet }
    );
  }

  clearTimeout(timer); // stream flows without a per-request deadline now
  return res;
}

/**
 * Build an OpenAI chat-completions request body with a strict whitelist
 * of pass-through params (tools, temperature, ...) — anything else the
 * client sent is dropped, never forwarded blindly upstream.
 */
const PASSTHROUGH_KEYS = ["temperature", "top_p", "max_tokens", "stop"];

function openAIBody({ model, messages, params = {}, stream = false, includeUsage = true }) {
  const body = { model, messages };
  if (stream) {
    body.stream = true;
    if (includeUsage) body.stream_options = { include_usage: true };
  }
  for (const k of PASSTHROUGH_KEYS) {
    if (params[k] !== undefined) body[k] = params[k];
  }
  if (Array.isArray(params.tools) && params.tools.length) {
    body.tools = params.tools;
    if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
  }
  return body;
}

/**
 * Shared CORS helper — opt-in via ALLOWED_ORIGIN env var.
 * Unset = no CORS headers at all (server-to-server clients need none).
 */
function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN;
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = { postJson, ApiError, setCors, openStream, openAIBody };
