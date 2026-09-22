/**
 * Offline smoke test for the ai-gateway wiring (no real API calls, no
 * network). Mocks global.fetch to simulate every provider, including SSE
 * streams, and exercises the REAL handlers + REAL SQLite file DB.
 *
 * Run:  npm install && npm test
 *
 * Covers: auth, fallback, normalization, model pinning, skipped-provider
 * accounting, streaming (OpenAI passthrough + Gemini conversion + tool
 * calls), tool-call normalization, SQLite store, limiter cascade,
 * /models + /usage endpoints, OpenAI-compat alias, Vercel rewrites,
 * Hermes-as-client surface (no hermes provider).
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

process.env.GATEWAY_SECRET = "test-secret";
process.env.GEMINI_API_KEY = "fake-gemini";
process.env.GROQ_API_KEY = "fake-groq";
// no OPENROUTER / CEREBRAS keys -> must be skipped with a reason

// Real SQLite DB (libsql file driver) for store + limiter-cascade tests
const TEST_DB = path.join(ROOT, "data", "smoke-test.db");
fs.mkdirSync(path.dirname(TEST_DB), { recursive: true });
[TEST_DB, TEST_DB + "-journal", TEST_DB + "-wal", TEST_DB + "-shm"].forEach((f) =>
  fs.rmSync(f, { force: true })
);
process.env.LIBSQL_URL = "file:" + TEST_DB;

// ── mock fetch ──────────────────────────────────────────────────────────
let calls = [];
const MOCK = { geminiMode: "fail429", groqMode: "ok" };

const enc = new TextEncoder();
function sseResponse(lines) {
  const body = lines.join("\n\n") + "\n\n";
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(body));
      c.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({
    url: u,
    headers: opts.headers || {},
    body: opts.body ? JSON.parse(opts.body) : null
  });

  if (u.includes("generativelanguage.googleapis.com")) {
    if (MOCK.geminiMode === "fail429") {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: "Resource exhausted" } })
      };
    }
    if (MOCK.geminiMode === "fail500") {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    if (MOCK.geminiMode === "sse") {
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}',
        'data: {"candidates":[{"content":{"parts":[{"text":" there"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}'
      ]);
    }
    if (MOCK.geminiMode === "toolsse") {
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}],"role":"model"}}]}',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}'
      ]);
    }
    return { ok: false, status: 500, text: async () => "boom" };
  }

  if (u.includes("api.groq.com")) {
    if (MOCK.groqMode === "fail503") {
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "service unavailable" } })
      };
    }
    if (MOCK.groqMode === "toolcall") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Paris"}' }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
          })
      };
    }
    if (MOCK.groqMode === "sse") {
      return sseResponse([
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo!"}}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
        'data: [DONE]'
      ]);
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello from Groq!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        })
    };
  }

  throw new Error("unexpected fetch: " + u);
};

// ── harness ─────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    failCount++;
    process.exitCode = 1;
  } else {
    console.log("PASS:", label);
    passCount++;
  }
}

function mockRes() {
  const out = {
    statusCode: 0,
    body: null,
    headers: {},
    chunks: [],
    ended: false
  };
  out.status = (c) => {
    out.statusCode = c;
    return out;
  };
  out.json = (b) => {
    out.body = b;
    return out;
  };
  out.end = () => {
    out.ended = true;
    return out;
  };
  out.setHeader = (k, v) => {
    out.headers[k] = v;
    return out;
  };
  out.write = (s) => {
    out.chunks.push(String(s));
    return true;
  };
  out.flush = () => out;
  return out;
}

const auth = { authorization: "Bearer test-secret" };
const chatHandler = require(path.join(ROOT, "api/v1/chat.js"));

(async () => {
  // ── auth ──────────────────────────────────────────────────────────────
  const { checkAuth } = require(path.join(ROOT, "lib/auth.js"));
  assert(checkAuth({ headers: { authorization: "Bearer test-secret" } }) === true, "auth accepts correct secret");
  assert(checkAuth({ headers: { authorization: "Bearer wrong" } }) === false, "auth rejects wrong secret");
  assert(checkAuth({ headers: {} }) === false, "auth rejects missing header");

  // ── routing with fallback (non-stream) ────────────────────────────────
  const { routeRequest, routeRequestStream, DEFAULT_MODELS } = require(path.join(ROOT, "lib/router.js"));
  const result = await routeRequest({
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" }
    ]
  });
  assert(result.provider === "groq", "fell through to Groq after Gemini 429");
  assert(result.text === "Hello from Groq!", "Groq text extracted");
  assert(typeof result.usage.total_tokens === "number", "usage passed through");
  assert(calls[0].url.includes("generativelanguage"), "first hop hit Gemini");
  assert(calls[0].headers["x-goog-api-key"] === "fake-gemini", "Gemini key in header, not URL");
  assert(!calls[0].url.includes("fake-gemini"), "Gemini key NOT in query string");

  // ── normalization ─────────────────────────────────────────────────────
  const { normalizeResponse } = require(path.join(ROOT, "lib/normalize.js"));
  const norm = normalizeResponse({
    provider: result.provider,
    model: result.model,
    text: result.text,
    usage: result.usage,
    raw: result.raw
  });
  assert(norm.choices[0].message.content === "Hello from Groq!", "normalized shape has content");
  assert(!("raw" in norm), "raw excluded when GATEWAY_INCLUDE_RAW unset");
  assert(norm.provider === "groq" && norm.model === "llama-3.1-8b-instant", "provider + actual model reported");

  // ── pinned routing: touches exactly one provider, no cross-fallback ───
  calls = [];
  const pinnedErr = await routeRequest({
    messages: [{ role: "user", content: "hi" }],
    model: "gemini:gemini-2.5-flash-lite"
  }).catch((e) => e);
  assert(calls.length === 1, "pinned request touches exactly one provider");
  assert(pinnedErr instanceof Error && pinnedErr.message.includes("Pinned provider"), "pinned failure reported clearly");
  assert(pinnedErr.details.length === 1, "no fallback beyond pinned provider");

  // ── params + tools passthrough, tool_calls extraction (non-stream) ────
  MOCK.geminiMode = "fail429";
  MOCK.groqMode = "toolcall";
  calls = [];
  const toolParams = {
    temperature: 0.2,
    max_tokens: 256,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather lookup",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"]
          }
        }
      }
    ],
    tool_choice: "auto"
  };
  const r2 = await routeRequest({
    messages: [{ role: "user", content: "weather in Paris?" }],
    params: toolParams
  });
  const groqCalls = calls.filter((c) => c.url.includes("api.groq.com"));
  assert(groqCalls.length === 1, "tool request reached Groq");
  assert(
    groqCalls[0].body.tools &&
      groqCalls[0].body.tools[0].function.name === "get_weather" &&
      groqCalls[0].body.temperature === 0.2 &&
      groqCalls[0].body.max_tokens === 256 &&
      groqCalls[0].body.tool_choice === "auto",
    "tools + whitelisted params forwarded upstream"
  );
  assert(groqCalls[0].body.stream === undefined, "non-stream request stays non-stream upstream");
  assert(Array.isArray(r2.tool_calls) && r2.tool_calls[0].function.name === "get_weather", "tool_calls extracted (non-stream)");
  assert(r2.finish_reason === "tool_calls", "finish_reason tool_calls surfaced");

  const n2 = normalizeResponse({
    provider: r2.provider,
    model: r2.model,
    text: r2.text,
    usage: r2.usage,
    raw: r2.raw,
    tool_calls: r2.tool_calls,
    finish_reason: r2.finish_reason
  });
  assert(
    n2.choices[0].finish_reason === "tool_calls" &&
      n2.choices[0].message.tool_calls[0].id === "call_1" &&
      n2.choices[0].message.content === null,
    "normalized response carries tool_calls (content null)"
  );

  // ── OpenAI -> Gemini request mapping (buildPayload) ───────────────────
  const gem = require(path.join(ROOT, "lib/providers/gemini.js"));
  const payload = gem.buildPayload(
    [
      { role: "system", content: "Be terse." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "22C sunny" }
    ],
    toolParams
  );
  assert(payload.systemInstruction && payload.systemInstruction.parts[0].text === "Be terse.", "gemini: system -> systemInstruction");
  assert(payload.contents[0].role === "user" && payload.contents[0].parts[0].text === "weather?", "gemini: user turn kept");
  assert(
    payload.contents[1].role === "model" &&
      payload.contents[1].parts[0].functionCall &&
      payload.contents[1].parts[0].functionCall.name === "get_weather" &&
      payload.contents[1].parts[0].functionCall.args.city === "Paris",
    "gemini: assistant tool_calls -> functionCall parts"
  );
  assert(
    payload.contents[2].role === "user" &&
      payload.contents[2].parts[0].functionResponse &&
      payload.contents[2].parts[0].functionResponse.name === "get_weather" &&
      payload.contents[2].parts[0].functionResponse.response.result === "22C sunny",
    "gemini: tool result -> functionResponse with resolved name"
  );
  assert(
    payload.tools &&
      payload.tools[0].functionDeclarations[0].name === "get_weather" &&
      payload.tools[0].functionDeclarations[0].parameters.type === "OBJECT" &&
      payload.tools[0].functionDeclarations[0].parameters.properties.city.type === "STRING",
    "gemini: OpenAI tools -> functionDeclarations (types uppercased)"
  );
  assert(payload.toolConfig.functionCallingConfig.mode === "AUTO", "gemini: tool_choice auto -> AUTO");
  assert(payload.generationConfig.maxOutputTokens === 256 && payload.generationConfig.temperature === 0.2, "gemini: generationConfig mapped");

  // ── skipped-provider accounting on the all-fail path ──────────────────
  MOCK.groqMode = "fail503";
  const fail = await routeRequest({
    messages: [{ role: "user", content: "hi" }]
  }).catch((e) => e);
  assert(fail instanceof Error && Array.isArray(fail.details), "all-fail path throws with details");
  assert(fail.details.some((d) => d.startsWith("openrouter: skipped")), "unconfigured providers reported as skipped");
  assert(fail.details.some((d) => d.includes("cerebras")), "cerebras accounted for");

  // ── SQLite store: real libsql file DB ─────────────────────────────────
  const store = require(path.join(ROOT, "lib/store.js"));
  await store.logRequest({ provider: "gemini", model: "gemini-2.5-flash", status: "ok", latency_ms: 123, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  await store.logRequest({ provider: "gemini", model: "gemini-2.5-flash", status: "error", latency_ms: 55, error: "boom" });
  const usage0 = await store.getUsage(Date.now() - 60_000);
  assert(usage0.gemini && usage0.gemini.requests === 2 && usage0.gemini.errors === 1, "store logs + aggregates usage");
  assert(usage0.gemini.total_tokens === 30, "store sums tokens");
  assert(usage0.gemini.avg_latency_ms > 0, "store averages latency");

  // rate-limit cascade: no Redis configured -> must count via SQLite
  const { isRateLimited } = require(path.join(ROOT, "lib/rateLimiter.js"));
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await isRateLimited("storetest", 2));
  assert(JSON.stringify(seq) === JSON.stringify([false, false, true, true]), "limiter cascade counts via SQLite (cap 2): " + JSON.stringify(seq));

  // ── non-stream chat handler ───────────────────────────────────────────
  MOCK.groqMode = "ok";
  const resH = mockRes();
  await chatHandler({ method: "POST", headers: auth, body: { messages: [{ role: "user", content: "hi" }] } }, resH);
  assert(resH.statusCode === 200 && resH.body.provider === "groq", "chat endpoint 200 + routed");
  assert(resH.body.choices[0].message.content === "Hello from Groq!", "chat endpoint returns normalized body");
  const res401 = mockRes();
  await chatHandler({ method: "POST", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } }, res401);
  assert(res401.statusCode === 401, "chat endpoint auth 401");
  const res400 = mockRes();
  await chatHandler({ method: "POST", headers: auth, body: { messages: [{ role: "user", content: 42 }] } }, res400);
  assert(res400.statusCode === 400, "chat endpoint rejects malformed message");

  let u1 = await store.getUsage(Date.now() - 60_000);
  assert(u1.groq && u1.groq.requests === 1 && u1.groq.total_tokens === 9, "handler logged non-stream request");

  // ── streaming: OpenAI-compatible passthrough (Groq) ───────────────────
  MOCK.groqMode = "sse";
  const resS = mockRes();
  await chatHandler(
    { method: "POST", headers: auth, body: { messages: [{ role: "user", content: "stream hello" }], stream: true } },
    resS
  );
  const raw = resS.chunks.join("");
  assert(resS.headers["Content-Type"].includes("text/event-stream"), "SSE headers set");
  assert(resS.ended, "stream response ended");
  assert(raw.includes('"delta":{"role":"assistant","content":""}'), "stream opens with assistant role chunk");
  assert(raw.includes('"content":"Hel"') && raw.includes('"content":"lo!"'), "SSE content chunks piped through untouched");
  assert(raw.includes('"finish_reason":"stop"'), "SSE finish_reason present");
  assert(raw.includes("data: [DONE]"), "stream terminates with [DONE]");
  u1 = await store.getUsage(Date.now() - 60_000);
  assert(u1.groq.requests === 2 && u1.groq.total_tokens === 19, "stream usage sniffed from final chunk + logged (9+10=19)");

  // ── streaming: fallback still works before first byte (429 -> Groq) ───
  MOCK.groqMode = "sse";
  calls = [];
  const resF = mockRes();
  await chatHandler(
    { method: "POST", headers: auth, body: { messages: [{ role: "user", content: "again" }], stream: true } },
    resF
  );
  assert(calls[0].url.includes("generativelanguage") && calls.some((c) => c.url.includes("api.groq.com")), "streaming fell back from Gemini 429 to Groq");
  assert(resF.chunks.join("").includes("data: [DONE]"), "fallback stream completed");

  // ── streaming: Gemini alt=sse -> OpenAI chunk conversion ──────────────
  MOCK.geminiMode = "sse";
  const resG = mockRes();
  await chatHandler(
    { method: "POST", headers: auth, body: { messages: [{ role: "user", content: "hello" }], stream: true } },
    resG
  );
  const g = resG.chunks.join("");
  assert(g.includes('"provider":"gemini"') && g.includes('"model":"gemini-2.5-flash"'), "gemini chunks labeled");
  assert(g.includes('"content":"Hi"') && g.includes('"content":" there"'), "gemini SSE converted to OpenAI deltas");
  assert(g.includes('"finish_reason":"stop"'), "gemini finishReason STOP -> stop");
  assert(g.includes('"total_tokens":8'), "gemini usageMetadata -> usage");
  assert(g.includes("data: [DONE]"), "gemini stream DONE");

  // ── streaming: Gemini functionCall -> OpenAI tool_calls ───────────────
  MOCK.geminiMode = "toolsse";
  const resGT = mockRes();
  await chatHandler(
    { method: "POST", headers: auth, body: { messages: [{ role: "user", content: "weather in Paris?" }], stream: true } },
    resGT
  );
  const gt = resGT.chunks.join("");
  // On the wire, arguments is a JSON-encoded STRING → quotes are escaped
  assert(gt.includes('"tool_calls"') && gt.includes('"get_weather"') && gt.includes('\\"city\\"'), "gemini functionCall -> delta.tool_calls");
  assert(gt.includes('"finish_reason":"tool_calls"'), "gemini tool-call finish_reason converted");

  // ── streaming error before first byte -> JSON 502 ─────────────────────
  MOCK.geminiMode = "fail429";
  MOCK.groqMode = "fail503";
  const res502 = mockRes();
  await chatHandler(
    { method: "POST", headers: auth, body: { messages: [{ role: "user", content: "hi" }], stream: true } },
    res502
  );
  assert(res502.statusCode === 502 && res502.body && res502.body.error, "stream all-fail returns JSON 502 (nothing streamed)");
  assert(Array.isArray(res502.body.details) && res502.body.details.length === 4, "stream 502 details list every provider");

  // ── endpoints: GET /models + GET /usage ───────────────────────────────
  const modelsEp = require(path.join(ROOT, "api/v1/models.js"));
  const usageEp = require(path.join(ROOT, "api/v1/usage.js"));
  const resM = mockRes();
  await modelsEp({ method: "GET", headers: auth }, resM);
  assert(resM.statusCode === 200 && resM.body.object === "list", "models endpoint returns OpenAI-style list");
  assert(
    resM.body.data.some((m) => m.id.startsWith("gemini:")) && resM.body.data.some((m) => m.id.startsWith("groq:")),
    "models list includes configured providers in pinned form"
  );
  assert(
    !resM.body.data.some((m) => m.id.startsWith("openrouter:")) && !resM.body.data.some((m) => m.id.startsWith("hermes:")),
    "models list omits unconfigured providers (and there is no hermes provider)"
  );
  const resU = mockRes();
  await usageEp({ method: "GET", headers: auth }, resU);
  assert(resU.statusCode === 200 && resU.body.enabled === true, "usage endpoint reads SQLite store");
  assert(resU.body.providers.gemini && resU.body.providers.gemini.requests === 4, "usage endpoint aggregates per provider (2 direct + 2 streamed)");

  // ── OpenAI-compat alias + Hermes-as-client surface ────────────────────
  const alias = require(path.join(ROOT, "api/v1/chat/completions.js"));
  assert(alias === chatHandler, "chat/completions is the same handler (Hermes Agent compat)");
  assert(!("hermes" in DEFAULT_MODELS), "no hermes provider in DEFAULT_MODELS (Hermes is a client, not a model)");
  assert(!fs.existsSync(path.join(ROOT, "lib", "providers", "hermes.js")), "hermes provider adapter removed");

  // ── Vercel rewrites: Hermes Agent base_url variants all resolve ───────
  const vcfg = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const srcs = (vcfg.rewrites || []).map((r) => r.source);
  assert(srcs.includes("/v1/:path*"), "rewrite: /v1/* -> /api/v1/* (standard OpenAI base_url)");
  assert(srcs.includes("/chat/completions") && srcs.includes("/models"), "rewrite: /v1-dropped paths covered (Hermes OPENAI_BASE_URL bug)");

  // ── chat UI bundle (public/) ───────────────────────────────────────────
  const uiHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const uiJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const uiCss = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  assert(uiHtml.includes('href="./style.css"') && uiHtml.includes('src="./app.js"'), "UI: index.html references local style.css + app.js (no CDN)");
  assert(uiHtml.includes('id="settingsModal"') && uiHtml.includes('id="usageBody"'), "UI: settings modal + usage panel present");
  new Function(uiJs); // throws on any syntax error
  assert(true, "UI: app.js parses as valid JS");
  assert(/chat\/completions/.test(uiJs), "UI: app.js calls the OpenAI chat-completions path");
  assert(uiJs.includes("getReader(") && uiJs.includes("data:"), "UI: app.js parses SSE chunks (streaming client)");
  assert(uiJs.includes("localStorage") || uiJs.includes("store."), "UI: conversations persist in localStorage");
  assert(!/https?:\/\/(cdn|unpkg|jsdelivr|googleapis|js\.delivr)/i.test(uiJs + uiCss + uiHtml.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, "")), "UI: no external CDN requests (self-contained, private)");
  assert(uiJs.includes("Bearer ") && uiJs.includes("apiKey"), "UI: sends the user's GATEWAY_SECRET as Bearer");

  console.log(`\nSmoke test complete: ${passCount} passed, ${failCount} failed.`);
})();
