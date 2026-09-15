# Personal AI Gateway

One API endpoint you control, deployed free on Vercel. It routes each request to whichever free-tier AI provider is available — with automatic fallback (including mid-request streaming fallback), normalized OpenAI-style responses, your own auth key, and optional SQLite storage — so nobody else can burn your quotas.

```
Browser (built-in chat UI at "/")  ·  Your app / Hermes Agent / any OpenAI SDK
      │  Authorization: Bearer <GATEWAY_SECRET>
      ▼
Vercel serverless function   /v1/chat/completions  /v1/models  (or /api/v1/*)
      │  auth → router → provider adapter → SSE pipe / normalize → rate limit
      ▼
Gemini → Groq → OpenRouter → Cerebras   (first one that answers wins)
      │
      └── SQLite via libSQL/Turso (optional): usage log + rate-limit counters
```

**Agent-ready**: `stream: true` (SSE chunks), `tools`/`tool_choice` passthrough with `tool_calls` in responses, `GET /v1/models` — the full OpenAI wire contract that agents like [Hermes Agent](https://hermes-agent.nousresearch.com) and OpenAI SDKs expect. See [Use with Hermes Agent](#use-with-hermes-agent).

## What differs from the original plan (and why)

| Change | Reason |
|---|---|
| Native `fetch`, dropped `node-fetch@2` | Vercel runs Node 18+; one less dependency, zero install for local testing |
| Per-provider `AbortSignal.timeout` + global time budget | A hanging provider used to eat the whole function; now fallback is fast and bounded (`PROVIDER_TIMEOUT_MS`, `GATEWAY_BUDGET_MS`) |
| Gemini key sent as `x-goog-api-key` header | Matches the plan's own provider table; keeps the key out of URLs/logs |
| Gemini system messages → `systemInstruction`, assistant → `model` role | The old flatten-to-one-prompt approach lost role structure in multi-turn chats |
| Default models updated for 2026-09 | `gemini-1.5-flash` and `llama3.1-8b` are retired; OpenRouter `:free` IDs churn — see table below |
| Redis optional + fail-open | `vercel dev` works before you create an Upstash DB; a Redis outage can't take the gateway down |
| Timing-safe secret comparison, fail-closed auth | Prevents timing attacks on `GATEWAY_SECRET` |
| Providers without configured keys are skipped | You can deploy with just one key and add the rest later |
| Empty/blocked responses throw | A safety-blocked Gemini answer now triggers fallback instead of returning `""` |
| `model` routing semantics | `"groq:<id>"` pins a provider; bare IDs pass through; omitted = each provider's default |
| `maxDuration` 30s | Plan's 10s was too tight for 4 fallback hops; 30s fits Vercel Hobby limits |
| SQLite storage layer (libSQL) | Metadata-only usage log + rate-limit counters: local `file:` DB in dev, Turso (hosted SQLite, free tier) in prod. Redis still wins for limiting when both are set; no storage configured = fully stateless mode |
| **SSE streaming** (`stream: true`) | Agents and OpenAI SDKs stream by default; upstream OpenAI chunks are piped through, Gemini's `alt=sse` is converted to OpenAI chunks. Fallback still works until the first byte is committed |
| **Tool-calling passthrough** | `tools`/`tool_choice` forwarded (whitelisted), `tool_calls` preserved in responses; OpenAI⇄Gemini function-call translation included |
| **`/v1/*` + `/chat/completions` path aliases** | Hermes Agent (and other tools) send different path styles depending on how `base_url` was entered — a known upstream quirk. All variants resolve to the same handler |
| **Hermes is a client, not a provider** | [Hermes Agent](https://hermes-agent.nousresearch.com) is an agent that *connects to* any OpenAI-compatible endpoint — this gateway is built to serve it (see below). Hermes-family *models* remain reachable via OpenRouter (`OPENROUTER_MODEL=nousresearch/hermes-4-70b`) |
| **Built-in chat UI (`public/`)** | Zero-dependency vanilla JS/CSS chat client served at `/` — streaming, model pinning, usage panel, localStorage conversations. No framework, no CDN, no webfonts: three static files that deploy with the gateway and cost nothing |

## Verified provider reality (as of 2026-09 — recheck before relying on it)

| Priority | Provider | Default model | Verified status | Free-tier notes |
|---|---|---|---|---|
| 1 | Gemini (AI Studio) | `gemini-2.5-flash` | Current; 1.5 family retired | Highest free limits; header auth |
| 2 | Groq | `llama-3.1-8b-instant` | Current "workhorse" | ≈30 req/min, 14.4k req/day free |
| 3 | OpenRouter | `openrouter/free` | Auto-router picks any live `:free` model | 20 req/min typical on `:free` |
| 4 | Cerebras | `gpt-oss-120b` | Free catalog pruned to GPT-OSS family | Fast backup; ~1M free tokens/day era limits |

> Want Hermes models in the chain? Set `OPENROUTER_MODEL=nousresearch/hermes-4-70b` (or pin `openrouter:nousresearch/hermes-4-70b` per request) — no extra adapter needed.

Sources: ai.google.dev/gemini-api/docs, console.groq.com/docs, openrouter.ai/docs (Free Models Router), inference-docs.cerebras.ai — all accessed 2026-09.

## Project structure

```
ai-gateway/
├── api/v1/
│   ├── chat.js              # the endpoint (text + SSE streaming; Vercel auto-detects /api)
│   ├── chat/completions.js  # OpenAI-SDK alias — same handler
│   ├── models.js            # GET OpenAI-style model list (pinned ids)
│   └── usage.js             # GET per-provider usage, last 24h (SQLite)
├── public/                  # the chat UI, served at "/" by Vercel
│   ├── index.html           # app shell + settings modal
│   ├── style.css            # dark theme, no frameworks/webfonts
│   └── app.js               # SSE chat client, conversations, usage panel
├── lib/
│   ├── auth.js             # timing-safe Bearer check
│   ├── router.js           # priority order + fallback + budget (text & stream paths)
│   ├── streaming.js        # SSE plumbing: OpenAI passthrough, Gemini chunk conversion
│   ├── rateLimiter.js      # Redis → SQLite → fail-open cascade
│   ├── normalize.js        # OpenAI-style response shape (tool_calls aware)
│   ├── http.js             # native fetch + timeouts + CORS + body builder
│   ├── store.js            # SQLite storage via libSQL (optional)
│   └── providers/          # one thin file per provider
│       ├── gemini.js       # incl. OpenAI⇄Gemini tool-call translation
│       ├── groq.js
│       ├── openrouter.js
│       └── cerebras.js
├── test/smoke.js           # offline test suite (npm test) — 76 assertions
├── .env.example            # every env var, documented
├── package.json
├── vercel.json             # maxDuration + /v1/* rewrites
└── README.md
```

## Quick start

```bash
npm install
npm test             # 76 offline assertions — no keys, no network needed
npm i -g vercel      # once
cp .env.example .env.local   # fill in GATEWAY_SECRET + at least one provider key
vercel dev
```

Then open **http://localhost:3000** — the built-in chat UI is served at `/`. On a fresh deployment the URL is `https://<your-app>.vercel.app`.

Grab keys before starting (all free): [Gemini](https://aistudio.google.com/apikey) · [Groq](https://console.groq.com/keys) · [OpenRouter](https://openrouter.ai/keys) · [Cerebras](https://cloud.cerebras.ai) · [Upstash](https://console.upstash.com) (optional).

Generate a strong gateway secret:

```bash
openssl rand -hex 32
```

## Test with curl

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one sentence"}]}'
```

(`/v1/chat/completions`, `/api/v1/chat`, `/api/v1/chat/completions` — all the same handler.)

Expected response:

```json
{
  "id": "gw-abc123-x7y2",
  "object": "chat.completion",
  "created": 1757168000,
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hello! How can I help you today?" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 5, "completion_tokens": 9, "total_tokens": 14 }
}
```

### Streaming

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Count to five"}],"stream":true}'
```

Emits standard `chat.completion.chunk` SSE events ending with `data: [DONE]`, whichever provider answered. If Gemini is over quota the router falls through to the next provider *before* the first byte; after streaming starts, an upstream failure is surfaced as an SSE error event + `[DONE]` (no silent truncation).

### Tool calling

Send OpenAI-format tools; `tool_calls` come back in `choices[0].message` with `finish_reason: "tool_calls"`:

```json
{
  "messages": [{"role":"user","content":"Weather in Paris?"}],
  "tools": [{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
  "tool_choice": "auto"
}
```

For Gemini the gateway translates both directions: `tools` → `functionDeclarations` (schemas uppercased to Gemini's Type enum), `role:"tool"` results → `functionResponse` parts (function name resolved from `tool_call_id`), `functionCall` parts → OpenAI `tool_calls` — in both streaming and non-streaming modes. Gemini's translation is best-effort (complex schemas may need simplification); the OpenAI-compatible providers speak tools natively.

Only whitelisted params are forwarded (`temperature`, `top_p`, `max_tokens`, `stop`, `tools`, `tool_choice`) — everything else a client sends is dropped, never passed upstream blindly.

### Model routing

```bash
# Auto: router picks the highest-priority healthy provider (default)
-d '{"messages":[...]}'

# Pin a provider + model (no fallback beyond it)
-d '{"messages":[...], "model": "groq:llama-3.1-8b-instant"}'

# Pass a literal model id: providers that don't know it fail fast, router falls through
-d '{"messages":[...], "model": "gpt-oss-120b"}'
```

Error responses: `401` wrong/missing secret · `400` malformed messages · `405` non-POST · `502` every provider failed — the `details` array tells you exactly why each one was skipped.

## SQLite storage (optional)

Serverless disks are ephemeral, so the gateway uses **libSQL** — SQLite with pluggable transports. Same driver, two modes:

| Mode | Config | What you get |
|---|---|---|
| Local dev | `LIBSQL_URL=file:data/gateway.db` | Plain SQLite file (gitignored) |
| Vercel prod | `LIBSQL_URL=libsql://you.turso.io` + `LIBSQL_AUTH_TOKEN=...` | [Turso](https://turso.tech) — hosted SQLite, free tier |
| Neither | unset | Fully stateless mode; everything still works |

What's stored — **metadata only, never message contents**:

- `request_log` — provider, model, status, latency, token usage, error text (one row per request, streamed ones included; auto-pruned after `LOG_RETENTION_DAYS`, default 30)
- `rate_counters` — fixed-window per-provider counters

The rate limiter now cascades: **Redis → SQLite → fail-open**. If Upstash is configured it stays first choice; otherwise SQLite counts; with neither, limiting is off.

Turso setup (one minute):

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso db create gateway
turso db show gateway --url          # → LIBSQL_URL
turso db tokens create gateway       # → LIBSQL_AUTH_TOKEN
```

## Observability endpoints

Both require the same Bearer secret.

```bash
# Which providers are configured right now? (Hermes Agent probes this too)
curl https://your-app.vercel.app/v1/models \
  -H "Authorization: Bearer $GATEWAY_SECRET"

# Per-provider usage, last 24h (needs SQLite storage)
curl https://your-app.vercel.app/v1/usage \
  -H "Authorization: Bearer $GATEWAY_SECRET"
```

`/models` returns pinned ids you can pass straight back as `model`:

```json
{
  "object": "list",
  "data": [
    { "id": "gemini:gemini-2.5-flash", "object": "model", "owned_by": "gemini" },
    { "id": "groq:llama-3.1-8b-instant", "object": "model", "owned_by": "groq" }
  ]
}
```

## Built-in chat UI

Deploying the gateway automatically deploys a small chat client: whatever is in `public/` is served at `/` by Vercel (same free deployment, no extra config). Open `https://<your-app>.vercel.app` and chat.

It is deliberately boring technology — **three static files, zero dependencies, no CDN, no webfonts, no analytics** — so it stays private, loads instantly, and never breaks a build.

| Feature | How it works |
|---|---|
| Streaming replies | `stream: true` SSE via `fetch` + `ReadableStream`; renders deltas live with a typing indicator and a **Stop** button (`AbortController`) |
| Model pinning | Populates the picker from `GET /v1/models` — only providers with configured keys are listed; “auto” walks the whole fallback chain |
| Base URL auto-fix | Paste a bare domain without `/v1` and the UI probes `/models`, detects the correct base (like the gateway's own rewrites) and remembers it |
| Usage panel | `GET /v1/usage` — per-provider requests/errors/tokens/avg latency for the last 24h (needs SQLite storage) |
| Conversations | Multi-chat list stored in your browser's `localStorage` (nothing on the server); new / switch / delete, auto-titled from your first message |
| Markdown-lite | Escaped-then-formatted: code blocks with copy buttons, inline code, bold, links, lists, quotes. XSS-safe by construction |
| Message extras | Per-message copy, retry the last exchange, export a conversation as Markdown |
| Settings | Base URL, API key, model, streaming on/off, temperature, max tokens, system prompt — saved locally, connection status dot probes `/models` |

**Key handling**: your `GATEWAY_SECRET` is kept in this browser's `localStorage` and sent only to your configured gateway URL — same-origin by default, so no CORS setup is needed. It never touches any third party. Avoid shared computers (or clear site data afterwards).

Notes:

- The UI talks to `/v1/chat/completions` exactly like Hermes Agent does — it's a reference client for the same contract.
- Conversations live in the browser only. The server-side SQLite store keeps **metadata only** (provider, model, latency, tokens) — never message contents.
- No streaming? Toggle it off in Settings to use plain JSON responses.

## Use with Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) is an agent that works with **any OpenAI-compatible endpoint** — this gateway is exactly that, with free-tier fallback behind it. One-time setup, on the *agent* side:

```bash
hermes model        # → select "Custom endpoint"
```

| Setting | Value |
|---|---|
| Provider type | OpenAI-compatible / Custom endpoint |
| Base URL (`base_url`) | `https://<your-app>.vercel.app/v1` |
| API key | your `GATEWAY_SECRET` |
| Model | any pinned id from `GET /v1/models`, e.g. `gemini:gemini-2.5-flash` |

Notes:

- **Endpoint verification**: Hermes Agent probes `GET /models` on the custom endpoint and shows the exact URL it checked — implemented here, so verification passes on the first try.
- **Any base URL style works**: `…/v1` (recommended), `…/api/v1`, or the bare domain — the gateway's Vercel rewrites cover the path variants, including the known quirk where a custom `OPENAI_BASE_URL` config drops `/v1` from the chat path.
- **Streaming + tools**: both supported end-to-end, so Hermes Agent's agentic loop (tool calls, streamed reasoning) runs against the fallback chain instead of a single provider.
- **What the agent sees**: a plain OpenAI-compatible server. Model pinning (`groq:…`, `gemini:…`) keeps its tool-calling turns on one provider for the whole conversation.

The same instructions apply to any OpenAI SDK client:

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-app>.vercel.app/v1", api_key=GATEWAY_SECRET)
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_SECRET` | **yes** | Your own Bearer key; gateway fails closed without it |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `CEREBRAS_API_KEY` | one+ | Providers without keys are skipped |
| `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` | no | SQLite storage: `file:data/gateway.db` (dev) or `libsql://…turso.io` + token (Turso, prod) |
| `LOG_RETENTION_DAYS` | no | `request_log` retention (default 30) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Rate-limit counters, 1st choice; absent → SQLite fallback → off |
| `GEMINI_MODEL` / `GROQ_MODEL` / `OPENROUTER_MODEL` / `CEREBRAS_MODEL` | no | Override defaults (see `.env.example`) |
| `PROVIDER_TIMEOUT_MS`, `GATEWAY_BUDGET_MS` | no | Per-hop timeout (default 8s) and total budget (28s) |
| `*_MAX_RPM` | no | Conservative per-minute caps with headroom |
| `GATEWAY_INCLUDE_RAW` | no | `1` echoes provider's raw JSON for debugging |
| `ALLOWED_ORIGIN` | no | Set to your site origin to allow browser calls (CORS) |
| `OPENROUTER_SITE_URL` | no | Optional attribution header for OpenRouter |

## Deploy to Vercel

```bash
git init
git add .
git commit -m "Initial gateway"
git remote add origin <your-github-repo-url>
git push -u origin main
```

1. vercel.com → New Project → import the repo.
2. Settings → Environment Variables → add every var from `.env.example` with real values (Production + Preview).
3. Deploy, then retest with the live domain instead of localhost, open `https://<your-app>.vercel.app` for the chat UI, and point Hermes Agent at `https://<your-app>.vercel.app/v1`.

## Security checklist

- [ ] `.env`/`.env.local` are gitignored and were never committed — verify: `git log --all --full-history -- .env`
- [ ] All provider keys live only in Vercel environment variables
- [ ] `GATEWAY_SECRET` generated via `openssl rand -hex 32`, not guessable
- [ ] Client apps call the gateway, never provider APIs directly
- [ ] No logging of request/response bodies containing keys (only metadata reaches the store)
- [ ] Repo private — or run [gitleaks](https://github.com/gitleaks/gitleaks) before making it public
- [ ] `ALLOWED_ORIGIN` unset (or a specific origin), never `*`, if browsers will call it
- [ ] Chat UI used only on devices you trust — your `GATEWAY_SECRET` lives in that browser's `localStorage` (clear site data on shared machines)

## Extending: adding a provider = one file

1. Copy `lib/providers/groq.js`, change `ENDPOINT`, env key, and default model (keep both `call*` and `stream*` exports).
2. Add one line to `PROVIDERS` in `lib/router.js` with its `envKey`, `fn`, `streamFn`, and `maxPerWindow`.
3. Add the key name to `.env.example` and to Vercel env vars.

## Known constraints to revisit

- Vercel Hobby `maxDuration` is 30s — that caps how long a single streamed answer can run; long agent turns on slow models may be cut off (upgrade plan or reduce max_tokens).
- Streaming commits to one provider after the first byte; mid-stream provider failure surfaces as an SSE error event, not a silent retry.
- Gemini tool-call translation is best-effort; complex JSON schemas (deep nesting, exotic formats) may need simplification. OpenAI-compatible providers pass tools through natively.
- Free-tier limits, model IDs, and endpoints change often — recheck each provider's docs when something starts 404-ing or 429-ing.
- Personal use only: most free tiers' terms prohibit reselling or sharing access through your key.
