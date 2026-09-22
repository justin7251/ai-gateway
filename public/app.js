/* Hermes Gateway — chat UI logic. Vanilla JS, zero dependencies, no CDNs.
 *
 * Talks OpenAI chat-completions to <base>/chat/completions (SSE streaming
 * by default), lists pinned models from GET /models, per-provider usage
 * from GET /usage. Settings + conversations live in this browser's
 * localStorage only — the gateway never stores message contents.
 *
 * Security model: the GATEWAY_SECRET is kept client-side and sent only to
 * the configured gateway base URL (default: this page's own origin /v1).
 */
(function () {
  "use strict";

  // ── tiny helpers ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* private mode etc. — in-memory only */
      }
    }
  };

  // ── state ──────────────────────────────────────────────────────────────
  const SETTINGS_KEY = "gw.settings.v1";
  const CONVS_KEY = "gw.convs.v1";
  const ACTIVE_KEY = "gw.active.v1";

  const DEFAULT_SETTINGS = {
    baseUrl: "", apiKey: "", model: "", stream: "1",
    temperature: "", maxTokens: "", system: ""
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get(SETTINGS_KEY, {}));
  let convs = store.get(CONVS_KEY, []); // [{id,title,messages:[{role,content,provider,model,usage,ms,error,stopped}]}]
  let activeId = store.get(ACTIVE_KEY, null);
  let pending = false;
  let controller = null;

  const activeConv = () => convs.find((c) => c.id === activeId) || null;

  function saveSettings() { store.set(SETTINGS_KEY, settings); }

  function saveConvs() {
    convs = convs.filter((c) => c.messages.length || c.id === activeId); // drop abandoned empties
    store.set(CONVS_KEY, convs);
    store.set(ACTIVE_KEY, activeId);
  }

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function apiBase() {
    const b = (settings.baseUrl || "").trim() || (location.origin + "/v1");
    return b.replace(/\/+$/, "");
  }

  function headers() {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (settings.apiKey || "")
    };
  }

  // ── markdown-lite (XSS-safe: everything is escaped before transforms) ──
  function mdToHtml(src) {
    const text = esc(src);

    // fenced code blocks -> placeholders
    const blocks = [];
    let t = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push({ lang: lang || "text", code });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    // inline code -> placeholders
    const inl = [];
    t = t.replace(/`([^`\n]+)`/g, (_m, c) => {
      inl.push(c);
      return "\u0000I" + (inl.length - 1) + "\u0000";
    });

    // links — only http(s) targets survive escaping with http intact
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // bold, then italic (bold first so ** doesn't turn into two <em>s)
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    // blockquote lines (">" was escaped to &gt;)
    t = t.replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");

    // headings
    t = t.replace(/^#{1,4} +(.*)$/gm, "<h3>$1</h3>");

    // lists: consecutive "- * " or "1. " lines become one <ul>/<ol>
    t = t.replace(/(?:^|\n)((?:[ \t]*(?:[-*]|\d+[.)]) +.+(?:\n|$))+)/g, (_m, block) => {
      const ordered = /^[ \t]*\d+[.)]/m.test(block);
      const items = block
        .trim()
        .split("\n")
        .map((l) => "<li>" + l.replace(/^[ \t]*(?:[-*]|\d+[.)]) +/, "") + "</li>")
        .join("");
      return "\n<" + (ordered ? "ol" : "ul") + ">" + items + "</" + (ordered ? "ol" : "ul") + ">";
    });

    // paragraphs: blank line splits; single newline -> <br>
    const html = t
      .split(/\n{2,}/)
      .map((p) => {
        const s = p.trim();
        if (!s) return "";
        if (/^\u0000B\d+\u0000$/.test(s)) return s; // bare code block stays bare
        if (/^<(ul|ol|blockquote|h3)/.test(s)) return s;
        return "<p>" + s.replace(/\n/g, "<br>") + "</p>";
      })
      .join("\n");

    // restore placeholders
    return html
      .replace(/\u0000B(\d+)\u0000/g, (_m, i) => {
        const b = blocks[Number(i)];
        return (
          '<div class="codeblock"><div class="cb-head"><span>' + esc(b.lang) + "</span>" +
          '<button class="cb-copy" type="button">copy</button></div>' +
          "<pre><code>" + esc(b.code.replace(/\n$/, "")) + "</code></pre></div>"
        );
      })
      .replace(/\u0000I(\d+)\u0000/g, (_m, i) => "<code>" + inl[Number(i)] + "</code>");
  }

  // ── connection status / toast ──────────────────────────────────────────
  function setDot(state, label) {
    const dot = $("statusDot");
    dot.className = "dot " + (state || "idle");
    $("statusLabel").textContent = label ||
      (state === "ok" ? "connected" : state === "bad" ? "error" : state === "busy" ? "connecting…" : "offline");
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
  }

  // If the user pasted a bare domain, /models there 404s — try +/v1 once
  // and remember whichever base answers (mirrors the gateway's own
  // "any base_url style works" philosophy).
  async function resolveBase() {
    const raw = (settings.baseUrl || "").trim();
    const stripped = raw.replace(/\/+$/, "");
    const candidates = raw
      ? Array.from(new Set([stripped, stripped + "/v1"]))
      : [location.origin + "/v1"];
    for (const base of candidates) {
      try {
        const r = await fetch(base + "/models", { headers: headers() });
        if (r.status !== 404 && r.status !== 405) return { base, ok: r.ok, status: r.status };
      } catch {
        /* network error — try the next candidate */
      }
    }
    return { base: candidates[0], ok: false, status: 0 };
  }

  function fillModels(list) {
    const sel = $("setModel");
    const current = settings.model || "";
    sel.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "auto — full fallback chain";
    sel.appendChild(auto);
    for (const m of list || []) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.id;
      sel.appendChild(o);
    }
    if (current && !(list || []).some((m) => m.id === current)) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current + " (custom)";
      sel.appendChild(o);
    }
    sel.value = current;
  }

  async function probeConnection(verbose) {
    setDot("busy");
    const r = await resolveBase();
    if (r.base !== apiBase()) {
      settings.baseUrl = r.base === location.origin + "/v1" ? "" : r.base;
      saveSettings();
    }
    if (!r.ok) {
      setDot("bad");
      if (verbose) {
        toast(
          r.status === 401
            ? "Gateway answered but rejected the key (401) — check GATEWAY_SECRET."
            : "Gateway not reachable at " + r.base + " (" + (r.status || "network error") + ")",
          true
        );
      }
      return false;
    }
    try {
      const res = await fetch(r.base + "/models", { headers: headers() });
      const data = await res.json();
      fillModels(data && data.data);
      setDot("ok");
      renderTopbar();
      if (verbose) {
        toast("Connected — " + ((data && data.data && data.data.length) || 0) + " model(s) available.");
      }
      return true;
    } catch (e) {
      setDot("bad");
      if (verbose) toast("Connected, but /models failed: " + e.message, true);
      return false;
    }
  }

  async function refreshUsage() {
    const body = $("usageBody");
    try {
      const res = await fetch(apiBase() + "/usage", { headers: headers() });
      if (res.status === 401) {
        body.innerHTML = '<p class="muted small">Unauthorized (401) — check the key.</p>';
        return;
      }
      const data = await res.json();
      if (!data.enabled) {
        body.innerHTML =
          '<p class="muted small">Storage off — set <code>LIBSQL_URL</code> (Turso in prod, <code>file:</code> in dev) to track usage.</p>';
        return;
      }
      const rows = Object.entries(data.providers || {});
      if (!rows.length) {
        body.innerHTML = '<p class="muted small">No requests in the last 24h.</p>';
        return;
      }
      body.innerHTML = rows
        .map(([name, p]) => {
          const bits = ["<b>" + p.requests + "</b> req"];
          if (p.errors) bits.push('<span class="u-err">' + p.errors + " err</span>");
          if (p.total_tokens) bits.push(p.total_tokens + " tok");
          if (p.avg_latency_ms) bits.push(p.avg_latency_ms + " ms avg");
          return (
            '<div class="usage-row"><span class="u-name">' + esc(name) + "</span><span>" +
            bits.join(" · ") + "</span></div>"
          );
        })
        .join("");
    } catch (e) {
      body.innerHTML = '<p class="muted small">Usage unavailable (' + esc(e.message) + ").</p>";
    }
  }

  // ── conversations ──────────────────────────────────────────────────────
  function newConv(focus) {
    const c = { id: uid(), title: "", messages: [] };
    convs.unshift(c);
    activeId = c.id;
    saveConvs();
    renderConvList();
    renderConv();
    closeSidebar();
    if (focus) $("input").focus();
    return c;
  }

  function deleteConv(id) {
    const c = convs.find((x) => x.id === id);
    if (!c) return;
    if (c.messages.length && !confirm("Delete this conversation? This only removes it from this browser.")) return;
    convs = convs.filter((x) => x.id !== id);
    if (activeId === id) activeId = convs.length ? convs[0].id : null;
    saveConvs();
    renderConvList();
    renderConv();
  }

  function renderConvList() {
    const nav = $("convList");
    nav.innerHTML = "";
    if (!convs.length) {
      nav.innerHTML = '<p class="muted small" style="padding:2px 6px">No conversations yet.</p>';
      return;
    }
    for (const c of convs) {
      const item = document.createElement("div");
      item.className = "conv-item" + (c.id === activeId ? " active" : "");
      item.innerHTML =
        '<span class="conv-title">' + esc(c.title || "New chat") + "</span>" +
        '<button class="conv-del" title="Delete conversation" aria-label="Delete conversation">' +
        '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></button>';
      item.addEventListener("click", (e) => {
        if (e.target.closest(".conv-del")) {
          deleteConv(c.id);
          return;
        }
        if (pending) { toast("Wait for the current reply (or stop it) first", true); return; }
        activeId = c.id;
        saveConvs();
        renderConvList();
        renderConv();
        closeSidebar();
      });
      nav.appendChild(item);
    }
  }

  // ── message rendering ──────────────────────────────────────────────────
  const HERO_HTML =
    '<div class="hero"><div class="hero-logo">' +
    '<svg viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#9a6dff"/></linearGradient></defs>' +
    '<rect width="64" height="64" rx="14" fill="url(#hg)"/>' +
    '<path d="M18 42V24a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H31l-9 9v-9h-4z" fill="#fff"/></svg></div>' +
    "<h2>Your gateway, in your browser.</h2>" +
    '<p class="muted">A zero-dependency chat client for your Personal AI Gateway — streaming, model pinning and usage stats included. Messages travel browser &rarr; your gateway &rarr; free-tier providers. Nothing else sees them.</p>' +
    '<div class="hints">' +
    '<button class="hint-card" data-act="hint" data-text="Explain how this gateway&#39;s provider fallback chain works, in 3 short bullet points.">Explain how the gateway&#39;s fallback chain works</button>' +
    '<button class="hint-card" data-act="hint" data-text="Write a haiku about deploying code on a Friday evening.">Write a haiku about Friday deploys</button>' +
    '<button class="hint-card" data-act="hint" data-text="Give me a 5-line Python function that retries an HTTP call with exponential backoff.">Retry-with-backoff snippet in Python</button>' +
    "</div>" +
    '<p id="heroSetup" class="muted small" style="margin-top:18px">First time? Open <b>Settings</b> (gear, top right) and paste your <code>GATEWAY_SECRET</code>.</p></div>';

  function metaHtml(m, isLast) {
    const chips = [];
    if (m.provider) chips.push('<span class="chip prov">' + esc(m.provider) + "</span>");
    if (m.model) chips.push('<span class="chip">' + esc(truncate(m.model, 42)) + "</span>");
    if (m.ms) chips.push('<span class="chip">' + (m.ms / 1000).toFixed(1) + "s</span>");
    if (m.usage && m.usage.total_tokens) chips.push('<span class="chip">' + m.usage.total_tokens + " tok</span>");
    if (m.stopped) chips.push('<span class="chip">stopped</span>');
    if (m.error) chips.push('<span class="chip" style="color:var(--err)">error: ' + esc(truncate(m.error, 140)) + "</span>");
    const acts = [];
    if (!pending) {
      acts.push('<button class="linklike" data-act="copy-msg" data-idx="' + m._idx + '">copy</button>');
      if (isLast && m.role === "assistant") acts.push('<button class="linklike" data-act="retry">retry</button>');
    }
    return chips.length || acts.length
      ? '<div class="meta">' + chips.join("") + acts.join("") + "</div>"
      : "";
  }

  function bubbleNode(m, isLast) {
    const el = document.createElement("div");
    if (m.role === "user") {
      el.className = "bubble user";
      el.innerHTML = '<div class="md">' + mdToHtml(m.content) + "</div>";
      return el;
    }
    el.className = "bubble assistant" + (m.error && !m.content ? " error" : "");
    el.innerHTML = '<div class="md">' + (m.content ? mdToHtml(m.content) : "") + "</div>" + metaHtml(m, isLast);
    return el;
  }

  function renderTopbar() {
    const conv = activeConv();
    $("chatTitle").textContent = (conv && (conv.title || "New chat")) || "New chat";
    $("chatMeta").textContent = (settings.model || "auto") + " · " + apiBase();
    $("chatMeta").title = apiBase();
  }

  function scrollBottom() {
    const w = $("messages");
    w.scrollTop = w.scrollHeight;
  }

  function renderConv() {
    const wrap = $("messages");
    const conv = activeConv();
    wrap.innerHTML = "";
    renderTopbar();

    if (!conv || !conv.messages.length) {
      wrap.innerHTML = HERO_HTML;
      setDotFromCache();
      return;
    }

    const col = document.createElement("div");
    col.className = "col";
    conv.messages.forEach((m, idx) => {
      // While streaming, the trailing empty assistant bubble is owned by the live node
      if (pending && idx === conv.messages.length - 1 && m.role === "assistant" && !m.content && !m.error) return;
      m._idx = idx;
      col.appendChild(bubbleNode(m, idx === conv.messages.length - 1 && !pending));
    });
    wrap.appendChild(col);
    scrollBottom();
  }

  function setDotFromCache() {
    // Only force the idle state when there is no key at all; otherwise keep
    // whatever the connection probe last reported.
    if (!settings.apiKey) setDot("idle", "no key");
  }

  function addLiveBubble() {
    const conv = activeConv();
    const wrap = $("messages");
    let col = wrap.querySelector(".col");
    if (!col) {
      wrap.innerHTML = "";
      col = document.createElement("div");
      col.className = "col";
      wrap.appendChild(col);
    }
    const el = document.createElement("div");
    el.className = "bubble assistant";
    el.innerHTML = '<div class="md"><span class="typing"><i></i><i></i><i></i></span></div>';
    col.appendChild(el);
    scrollBottom();
    return { el, md: el.querySelector(".md") };
  }

  // ── send / stream ──────────────────────────────────────────────────────
  function buildApiMessages(conv) {
    const tail = conv.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && (m.content || m.role === "user"))
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content || "" }));
    const sys = (settings.system || "").trim();
    return sys ? [{ role: "system", content: sys }].concat(tail) : tail;
  }

  function setPending(v) {
    pending = v;
    $("sendBtn").disabled = v || !$("input").value.trim();
    $("sendBtn").classList.toggle("hidden", v);
    $("stopBtn").classList.toggle("hidden", !v);
  }

  async function complete(conv) {
    const m = { role: "assistant", content: "" };
    conv.messages.push(m);

    const live = addLiveBubble();
    setPending(true);
    setDot("busy", "generating…");
    controller = new AbortController();
    const started = Date.now();
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        live.md.innerHTML = mdToHtml(m.content);
        scrollBottom();
      });
    };

    try {
      const body = { messages: buildApiMessages(conv) };
      if (settings.model) body.model = settings.model;
      if (settings.temperature !== "") body.temperature = Number(settings.temperature);
      if (settings.maxTokens !== "") body.max_tokens = Number(settings.maxTokens);
      const useStream = settings.stream === "1";
      if (useStream) body.stream = true;

      const res = await fetch(apiBase() + "/chat/completions", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
          const j = await res.json();
          if (j && j.error) msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
          if (j && Array.isArray(j.details) && j.details.length) msg += " — " + j.details.join(" | ");
        } catch { /* not JSON */ }
        throw new Error(msg);
      }

      if (useStream && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let ev;
            try { ev = JSON.parse(payload); } catch { continue; }
            if (ev.error) throw new Error(ev.error.message || "upstream stream error");
            const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
            if (d && typeof d.content === "string" && d.content) {
              m.content += d.content;
              paint();
            }
            if (ev.provider) m.provider = ev.provider;
            if (ev.model) m.model = ev.model;
            if (ev.usage) m.usage = ev.usage;
          }
        }
      } else {
        const j = await res.json();
        const msg = j.choices && j.choices[0] && j.choices[0].message;
        m.content = (msg && msg.content) || "(empty response)";
        m.provider = j.provider;
        m.model = j.model;
        m.usage = j.usage;
      }

      m.ms = Date.now() - started;
      setDot("ok");
    } catch (err) {
      if (err && err.name === "AbortError") {
        m.stopped = true; // user pressed Stop — keep partial content
      } else {
        m.error = (err && err.message) || "request failed";
        setDot("bad");
        if (m.error.indexOf("401") !== -1) openSettings();
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      controller = null;
      setPending(false);
      if (!conv.title && conv.messages[0] && conv.messages[0].content) {
        conv.title = truncate(conv.messages[0].content, 48);
      }
      saveConvs();
      renderConvList();
      renderConv();
      refreshUsage();
    }
  }

  function send(presetText) {
    if (pending) return;
    const text = (presetText != null ? presetText : $("input").value).trim();
    if (!text) return;
    if (!settings.apiKey) {
      openSettings();
      toast("Add your GATEWAY_SECRET first.", true);
      return;
    }
    const conv = activeConv() || newConv(false);
    conv.messages.push({ role: "user", content: text });
    $("input").value = "";
    autosize();
    renderConv();
    complete(conv);
  }

  function retry() {
    if (pending) return;
    const conv = activeConv();
    if (!conv) return;
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
      conv.messages.pop();
    }
    if (!conv.messages.length || conv.messages[conv.messages.length - 1].role !== "user") return;
    renderConv();
    complete(conv);
  }

  function stop() {
    if (controller) controller.abort();
  }

  // ── export / clear ─────────────────────────────────────────────────────
  function exportConv() {
    const conv = activeConv();
    if (!conv || !conv.messages.length) {
      toast("Nothing to export yet.", true);
      return;
    }
    const lines = ["# " + (conv.title || "Hermes Gateway chat"), ""];
    for (const m of conv.messages) {
      if (m.role === "user") {
        lines.push("**You:**", "", m.content, "");
      } else {
        const via = m.provider
          ? " _(via " + m.provider + (m.model ? ": " + m.model : "") + (m.ms ? ", " + (m.ms / 1000).toFixed(1) + "s" : "") + ")_"
          : "";
        lines.push("**Assistant" + via + ":**", "", m.content || (m.error ? "error: " + m.error : ""), "");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hermes-chat-" + new Date().toISOString().slice(0, 10) + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function clearChat() {
    const conv = activeConv();
    if (!conv || !conv.messages.length) return;
    if (!confirm("Clear this conversation from this browser?")) return;
    conv.messages = [];
    conv.title = "";
    saveConvs();
    renderConvList();
    renderConv();
  }

  // ── settings modal ─────────────────────────────────────────────────────
  function openSettings() {
    $("originHint").textContent = location.origin + "/v1";
    $("setBaseUrl").value = settings.baseUrl;
    $("setApiKey").value = settings.apiKey;
    // make sure a saved custom model id has its option before selecting it
    const sel = $("setModel");
    const hasModel = Array.from(sel.options).some((o) => o.value === (settings.model || ""));
    if (!sel.options.length || (settings.model && !hasModel)) fillModels([]);
    $("setModel").value = settings.model || "";
    $("setStream").value = settings.stream;
    $("setTemp").value = settings.temperature;
    $("setMaxTokens").value = settings.maxTokens;
    $("setSystem").value = settings.system;
    $("settingsModal").classList.remove("hidden");
    $("setApiKey").focus();
  }

  function closeSettings() {
    $("settingsModal").classList.add("hidden");
  }

  async function saveAndConnect() {
    settings.baseUrl = $("setBaseUrl").value.trim();
    settings.apiKey = $("setApiKey").value.trim();
    settings.model = $("setModel").value;
    settings.stream = $("setStream").value;
    settings.temperature = $("setTemp").value;
    settings.maxTokens = $("setMaxTokens").value;
    settings.system = $("setSystem").value;
    saveSettings();
    closeSettings();
    renderConv();
    const ok = await probeConnection(true);
    refreshUsage();
    if (ok) toast("Saved — connected to your gateway.");
  }

  // ── composer / sidebar wiring ──────────────────────────────────────────
  function autosize() {
    const input = $("input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
    $("sendBtn").disabled = pending || !input.value.trim();
  }

  function openSidebar() {
    $("sidebar").classList.add("open");
    $("scrim").classList.add("show");
  }
  function closeSidebar() {
    $("sidebar").classList.remove("open");
    $("scrim").classList.remove("show");
  }

  function wire() {
    $("newChatBtn").addEventListener("click", () => newConv(true));
    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsBtnSide").addEventListener("click", () => { closeSidebar(); openSettings(); });
    $("closeSettings").addEventListener("click", closeSettings);
    $("saveSettings").addEventListener("click", saveAndConnect);
    $("settingsModal").addEventListener("click", (e) => {
      if (e.target === $("settingsModal")) closeSettings();
    });
    $("toggleKey").addEventListener("click", () => {
      const k = $("setApiKey");
      k.type = k.type === "password" ? "text" : "password";
    });

    $("menuBtn").addEventListener("click", openSidebar);
    $("scrim").addEventListener("click", closeSidebar);

    $("sendBtn").addEventListener("click", () => send());
    $("stopBtn").addEventListener("click", stop);
    $("input").addEventListener("input", autosize);
    $("input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    $("clearChat").addEventListener("click", clearChat);
    $("exportBtn").addEventListener("click", exportConv);
    $("usageRefresh").addEventListener("click", refreshUsage);

    // delegated actions inside the message area (hints, copy, retry, code copy)
    $("messages").addEventListener("click", async (e) => {
      const cb = e.target.closest(".cb-copy");
      if (cb) {
        const code = cb.closest(".codeblock");
        const text = code ? code.querySelector("code").textContent : "";
        try {
          await navigator.clipboard.writeText(text);
          cb.textContent = "copied";
          setTimeout(() => { cb.textContent = "copy"; }, 1300);
        } catch {
          toast("Clipboard blocked by the browser.", true);
        }
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "hint") send(act.dataset.text);
      if (act.dataset.act === "retry") retry();
      if (act.dataset.act === "copy-msg") {
        const conv = activeConv();
        const m = conv && conv.messages[Number(act.dataset.idx)];
        if (m) {
          try {
            await navigator.clipboard.writeText(m.content || "");
            toast("Copied.");
          } catch {
            toast("Clipboard blocked by the browser.", true);
          }
        }
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("settingsModal").classList.contains("hidden")) closeSettings();
        else if (pending) stop();
      }
    });
  }

  // ── init ───────────────────────────────────────────────────────────────
  function init() {
    wire();
    renderConvList();
    renderConv();
    autosize();

    if (location.protocol === "file:") {
      toast("Open this page via vercel dev or your deployed URL — file:// can't reach the gateway.", true);
    }

    if (settings.apiKey) {
      probeConnection(false).then((ok) => {
        refreshUsage();
        if (!ok) toast("Not connected — check Settings (base URL / key).", true);
      });
    } else {
      $("usageBody").innerHTML = '<p class="muted small">Add your key in Settings to see usage.</p>';
      openSettings();
    }
  }

  init();
})();
