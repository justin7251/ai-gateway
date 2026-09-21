/**
 * Server-Sent Events plumbing for `stream: true` requests.
 *
 * The client ALWAYS receives OpenAI chat.completion.chunk wire format —
 * that's what agents like Hermes Agent and OpenAI SDKs expect. Two
 * upstream flavors are handled:
 *
 *   - "openai" (Groq / OpenRouter / Cerebras): upstream already emits
 *     OpenAI chunks, so bytes are piped through untouched. Usage is
 *     sniffed from the final chunk for the SQLite log (best-effort).
 *   - "gemini": Gemini's alt=sse events (candidates/parts) are converted
 *     to OpenAI chunks here, including functionCall -> tool_calls.
 *
 * Fallback semantics: a provider that fails BEFORE the first byte is
 * streamed throws (router falls through). Once streaming has started we
 * can't fall back — an error event + [DONE] is emitted instead.
 */

const crypto = require("crypto");

function chunkId() {
  return `gw-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

function makeChunk({ id, provider, model, delta = {}, finish_reason = null, usage }) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    provider,
    model,
    choices: [{ index: 0, delta, finish_reason }]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

// Most SDK clients expect the first delta to announce the assistant role.
function openRoleChunk({ id, provider, model }) {
  return makeChunk({ id, provider, model, delta: { role: "assistant", content: "" } });
}

/**
 * Best-effort: pull the flat usage object out of the tail of a piped
 * upstream stream (works for top-level `usage` and Groq's `x_groq.usage`).
 */
function sniffUsage(tail) {
  const i = tail.lastIndexOf('"usage"');
  if (i === -1) return undefined;
  const start = tail.indexOf("{", i);
  const end = tail.indexOf("}", i);
  if (start === -1 || end === -1) return undefined;
  try {
    const u = JSON.parse(tail.slice(start, end + 1));
    return {
      prompt_tokens: u.prompt_tokens ?? null,
      completion_tokens: u.completion_tokens ?? null,
      total_tokens: u.total_tokens ?? null
    };
  } catch (_) {
    return undefined;
  }
}

/**
 * Pipe an OpenAI-compatible upstream SSE stream to the client as-is.
 * @returns {{ usage: object|undefined, interrupted: boolean }}
 */
async function pipeOpenAIStream({ upstream, res, provider, model }) {
  sseHeaders(res);
  if (typeof res.flush === "function") res.flush();

  const id = chunkId();
  res.write(`data: ${JSON.stringify(openRoleChunk({ id, provider, model }))}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let sawDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      res.write(text);
      tail = (tail + text).slice(-65536);
      if (tail.indexOf("[DONE]") !== -1) sawDone = true;
    }
  } catch (err) {
    // Mid-stream upstream failure: tell the client, don't leave it hanging.
    try {
      res.write(
        `data: ${JSON.stringify({ error: { message: `upstream stream failed: ${err.message}`, provider } })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (_) {}
    return { usage: sniffUsage(tail), interrupted: true };
  }

  if (!sawDone) res.write("data: [DONE]\n\n");
  res.end();
  return { usage: sniffUsage(tail), interrupted: false };
}

/**
 * Read Gemini alt=sse events and re-emit them as OpenAI chunks.
 * @returns {{ usage: object|undefined, interrupted: boolean }}
 */
async function pipeGeminiStream({ upstream, res, provider, model }) {
  sseHeaders(res);
  if (typeof res.flush === "function") res.flush();

  const id = chunkId();
  const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  send(openRoleChunk({ id, provider, model }));

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage;
  let sawFunctionCall = false;
  let finished = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Process complete lines only; keep the (possibly partial) last line.
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch (_) {
          continue;
        }

        const cand = ev.candidates && ev.candidates[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        for (const p of parts) {
          if (typeof p.text === "string" && p.text) {
            send(makeChunk({ id, provider, model, delta: { content: p.text } }));
          }
          if (p.functionCall) {
            sawFunctionCall = true;
            send(
              makeChunk({
                id,
                provider,
                model,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      type: "function",
                      id: `call_${crypto.randomBytes(6).toString("hex")}`,
                      function: {
                        name: p.functionCall.name || "",
                        arguments: JSON.stringify(p.functionCall.args || {})
                      }
                    }
                  ]
                }
              })
            );
          }
        }

        if (ev.usageMetadata) {
          usage = {
            prompt_tokens: ev.usageMetadata.promptTokenCount ?? null,
            completion_tokens: ev.usageMetadata.candidatesTokenCount ?? null,
            total_tokens: ev.usageMetadata.totalTokenCount ?? null
          };
        }
        if (cand && cand.finishReason) {
          const fr =
            cand.finishReason === "MAX_TOKENS" ? "length" : sawFunctionCall ? "tool_calls" : "stop";
          // OpenAI convention: usage rides on the final chunk.
          send(makeChunk({ id, provider, model, delta: {}, finish_reason: fr, usage }));
          finished = true;
        }
      }
    }
  } catch (err) {
    send({ error: { message: `upstream stream failed: ${err.message}`, provider } });
    send(makeChunk({ id, provider, model, delta: {}, finish_reason: "stop" }));
    try {
      res.end();
    } catch (_) {}
    return { usage, interrupted: true };
  }

  if (!finished) {
    send(makeChunk({ id, provider, model, delta: {}, finish_reason: sawFunctionCall ? "tool_calls" : "stop", usage }));
  }
  res.write("data: [DONE]\n\n");
  res.end();
  return { usage, interrupted: false };
}

module.exports = { pipeOpenAIStream, pipeGeminiStream };
