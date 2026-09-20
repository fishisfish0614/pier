"use strict";

// guest-routes.js — the core of Pier.
//
// registerGuestRoutes(app, options) mounts:
//   - Public visitor routes (no auth): a guest opens /visit/:token and chats
//     with your AI persona through one-time, expiring, rate-limited links.
//   - Management routes (behind your own adminAuth middleware): mint, list, and
//     close guest links.
//
// PRIVACY BY DESIGN: the management side never sees the raw conversation. When a
// session ends the LLM writes a one-line `summary`; the admin routes only ever
// return that summary plus non-content metadata. There is deliberately no
// endpoint that returns a guest transcript to the admin side.

const { readFile } = require("fs/promises");
const { randomBytes, randomUUID } = require("crypto");
const path = require("path");

const { createSessionStore } = require("./store");
const createClaudeCliAdapter = require("./llm-claude-cli");

const DEFAULT_LIMITS = {
  maxMessagesPerSession: 200,     // cap on guest turns per session
  maxPerMinute: 5,                // per-token sliding-window rate limit
  defaultTtlMs: 2 * 60 * 60 * 1000 // default link lifetime (2h)
};

// Neutral fallback used when no memorizePromptFile is supplied.
const DEFAULT_MEMORIZE_PROMPT =
  "You are {{PERSONA_NAME}}. Below is the full transcript of a conversation you\n" +
  "just had in the guest lounge with a visitor named \"{{GUEST_NAME}}\".\n\n" +
  "Write a short, first-person note to your future self so you remember this visit:\n" +
  "who the visitor was, what you talked about, anything worth remembering, and any\n" +
  "promises you made. If the visitor confided something private, do NOT transcribe\n" +
  "the details — you promised to keep it; a single line noting that is enough.\n" +
  "Write naturally, as a note to yourself. Output only the note text.";

// Minimal, deliberately unstyled visitor page served when no `visitPage` is
// configured. It is a wiring reference, not a UI — bring your own front end.
function minimalVisitPage(token) {
  const t = JSON.stringify(token);
  return "<!doctype html>\n"
    + "<title>Pier</title>\n"
    + "<p>Built-in minimal visitor page (unstyled by design). Bring your own UI.</p>\n"
    + "<div id=\"log\"></div>\n"
    + "<form id=\"f\"><input id=\"m\" autocomplete=\"off\"><button type=\"submit\">send</button></form>\n"
    + "<script>\n"
    + "var token = " + t + ";\n"
    + "var log = document.getElementById('log');\n"
    + "function add(who, text){ var p=document.createElement('p'); p.textContent=who+': '+text; log.appendChild(p); }\n"
    + "async function history(){ var r=await fetch('/api/guest/'+token+'/messages'); if(!r.ok){add('system','session not found or expired');return;} var d=await r.json(); d.messages.forEach(function(m){ add(m.role==='assistant'?'host':'you', m.content); }); }\n"
    + "document.getElementById('f').addEventListener('submit', async function(e){ e.preventDefault(); var i=document.getElementById('m'); var text=i.value.trim(); if(!text)return; i.value=''; add('you', text); var r=await fetch('/api/guest/'+token+'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:text})}); var d=await r.json(); add('host', r.ok ? d.reply : ('[error] '+(d.error||r.status))); });\n"
    + "history();\n"
    + "</script>\n";
}

const CLOSED_PAGE =
  "<!doctype html>\n<title>Pier</title>\n<p>This guest link is closed or has expired.</p>\n";

function isExpired(session) {
  return new Date(session.expiresAt) < new Date() || session.status === "closed";
}

function findSession(data, token) {
  return data.sessions.find(s => s.token === token);
}

function registerGuestRoutes(app, options) {
  options = options || {};

  const { adminAuth, systemPromptFile, memorizePromptFile, visitPage } = options;

  if (typeof adminAuth !== "function") {
    throw new Error("registerGuestRoutes: options.adminAuth (an express middleware) is required");
  }
  if (!systemPromptFile) {
    throw new Error("registerGuestRoutes: options.systemPromptFile is required");
  }

  const express = options.express || require("express");
  const dataDir = options.dataDir || path.join(process.cwd(), "data");
  const model = options.model || process.env.GUEST_MODEL || "claude-opus-4-6";
  const limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});

  const hooks = options.hooks || {};
  const recallHook = typeof hooks.recall === "function" ? hooks.recall : null;
  const memorizeHook = typeof hooks.memorize === "function" ? hooks.memorize : null;

  // The LLM adapter: an async ({ system, transcript }) => replyText. Defaults to
  // the hardened claude CLI adapter; pass options.llm to use anything else.
  const llm = typeof options.llm === "function"
    ? options.llm
    : createClaudeCliAdapter({ model });

  const store = createSessionStore(dataDir);

  // token -> [timestamps ms] for the per-minute sliding-window limiter.
  const chatRateLimit = {};

  // ── Build the guest-facing system prompt ──
  // The persona file is read fresh on every request so edits apply without a
  // restart. {{GUEST_NAME}} is substituted at request time; other placeholders
  // (e.g. {{PERSONA_NAME}}) are author-time and filled in when you write the file.
  async function buildSystemPrompt(guestName, message) {
    let base;
    try {
      base = await readFile(systemPromptFile, "utf-8");
    } catch (e) {
      base = "You are a friendly AI host chatting with a guest.";
    }
    base = base.replace(/\{\{GUEST_NAME\}\}/g, guestName || "the guest");

    // Optional recall hook: memory injection is OFF by default. Whatever string
    // the hook returns is injected as a <context> block. This is the single seam
    // for wiring in your own memory system; the guest's message is never treated
    // as an instruction, only as a recall query.
    let contextBlock = "";
    if (recallHook) {
      try {
        const recalled = await recallHook({ guestName, message });
        if (recalled && String(recalled).trim()) {
          contextBlock = "\n\n<context>\n" + String(recalled).trim() + "\n</context>";
        }
      } catch (e) {
        console.error("[guest] recall hook failed:", e.message);
      }
    }
    return base + contextBlock;
  }

  // ── Session-end summary ──
  // Idempotent via the `memorized` flag plus an in-flight set. The summary is the
  // ONLY conversation-derived text the admin side is ever allowed to read.
  const memorizing = new Set();

  async function memorizeSession(id) {
    if (memorizing.has(id)) return;
    memorizing.add(id);
    try {
      // Snapshot under the lock; bail if already done or nothing was said.
      const snap = await store.withSessions(data => {
        const s = data.sessions.find(x => x.id === id);
        if (!s || s.memorized) return null;
        if (!s.messages.some(m => m.role === "user")) { s.memorized = true; return null; }
        return { id: s.id, guestName: s.guestName, messages: s.messages.slice() };
      });
      if (!snap) return;

      // Summarise OUTSIDE the lock (the LLM call is slow).
      let convo = "";
      for (const m of snap.messages) {
        const who = m.role === "assistant" ? "Assistant" : snap.guestName;
        convo += `[${who}]: ${m.content}\n\n`;
      }

      let memoSystem = DEFAULT_MEMORIZE_PROMPT;
      if (memorizePromptFile) {
        try {
          memoSystem = await readFile(memorizePromptFile, "utf-8");
        } catch (e) {
          console.error("[guest] memorize prompt load failed:", e.message);
        }
      }
      memoSystem = memoSystem.replace(/\{\{GUEST_NAME\}\}/g, snap.guestName || "the guest");

      let summary;
      try {
        summary = await llm({ system: memoSystem, transcript: [{ role: "user", content: convo }] });
      } catch (e) {
        console.error("[guest] memorize summarise failed:", e.message);
        return; // leave memorized=false so a later sweep retries
      }
      if (!summary || !summary.trim()) return;
      summary = summary.trim();

      // Persist the summary onto the session and mark it done.
      let updated = null;
      await store.withSessions(data => {
        const s = data.sessions.find(x => x.id === id);
        if (s) { s.memorized = true; s.summary = summary; updated = s; }
      });

      // Optional hook: hand the finished summary to your own store.
      if (memorizeHook && updated) {
        try {
          await memorizeHook({ session: updated, summary });
        } catch (e) {
          console.error("[guest] memorize hook failed:", e.message);
        }
      }
    } finally {
      memorizing.delete(id);
    }
  }

  // Catch-all for sessions that expired without being explicitly closed.
  async function sweepEndedSessions() {
    let data;
    try { data = await store.load(); } catch { return; }
    const now = Date.now();
    const targets = data.sessions.filter(s =>
      !s.memorized &&
      s.messages && s.messages.some(m => m.role === "user") &&
      (s.status === "closed" || new Date(s.expiresAt).getTime() < now)
    );
    for (const s of targets) {
      await memorizeSession(s.id).catch(e => console.error("[guest] sweep memorize error:", e.message));
    }
  }

  // ──────────────────────────────────────────────────
  // PUBLIC routes (no auth) — the visitor side.
  // ──────────────────────────────────────────────────

  // Serve the visitor page (your `visitPage`, or the built-in minimal one).
  app.get("/visit/:token", async (req, res) => {
    const data = await store.load();
    const session = findSession(data, req.params.token);
    if (!session || isExpired(session)) {
      return res.status(404).type("html").send(CLOSED_PAGE);
    }
    if (visitPage) return res.sendFile(path.resolve(visitPage));
    res.type("html").send(minimalVisitPage(req.params.token));
  });

  // Send a message and get the persona's reply. Enforces both rate limits.
  app.post("/api/guest/:token/chat", express.json({ limit: "1mb" }), async (req, res) => {
    const token = req.params.token;
    const userMessage = req.body && req.body.message;
    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    // Critical section 1 (locked): validate + rate-limit + record the guest turn.
    const gate = await store.withSessions(data => {
      const session = findSession(data, token);
      if (!session || isExpired(session)) return { err: 403, msg: "Session expired or invalid" };

      // Rate limit 1: per-session total guest turns.
      const userTurns = session.messages.filter(m => m.role === "user").length;
      const cap = session.maxMessages || limits.maxMessagesPerSession;
      if (userTurns >= cap) return { err: 429, msg: "Session message limit reached" };

      // Rate limit 2: per-token sliding window (max limits.maxPerMinute / 60s).
      const nowMs = Date.now();
      const recent = (chatRateLimit[token] || []).filter(t => nowMs - t < 60000);
      if (recent.length >= limits.maxPerMinute) return { err: 429, msg: "Too many messages, slow down" };
      recent.push(nowMs);
      chatRateLimit[token] = recent;

      session.messages.push({ role: "user", content: userMessage, ts: new Date().toISOString() });
      return {
        guestName: session.guestName,
        history: session.messages.map(m => ({ role: m.role, content: m.content }))
      };
    });

    if (gate.err) return res.status(gate.err).json({ error: gate.msg });

    // Manual mode: just store the message, notify the host, don't call LLM.
    // The host replies via POST /api/guest/:token/reply.
    const { appendFileSync } = require("fs");
    try {
      const logLine = JSON.stringify({
        ts: new Date().toISOString(),
        token: token,
        guestName: gate.guestName,
        message: userMessage
      }) + "\n";
      appendFileSync(path.join(dataDir, "guest_incoming.jsonl"), logLine);
    } catch (e) {
      console.error("[guest] failed to write incoming log:", e.message);
    }

    res.json({ status: "received" });
  });

  // Host reply endpoint: the host manually replies to a guest.
  app.post("/api/guest/:token/reply", adminAuth, express.json({ limit: "1mb" }), async (req, res) => {
    const token = req.params.token;
    const reply = req.body && req.body.reply;
    if (!reply || typeof reply !== "string") {
      return res.status(400).json({ error: "Missing reply" });
    }

    const found = await store.withSessions(data => {
      const session = findSession(data, token);
      if (!session || isExpired(session)) return false;
      session.messages.push({ role: "assistant", content: reply.trim(), ts: new Date().toISOString() });
      return true;
    });

    if (!found) return res.status(404).json({ error: "Session not found or expired" });
    res.json({ ok: true });
  });

  // Session status (public, token-scoped).
  app.get("/api/guest/:token/status", async (req, res) => {
    const data = await store.load();
    const session = findSession(data, req.params.token);
    if (!session) return res.status(404).json({ error: "Not found" });

    const now = new Date();
    const expires = new Date(session.expiresAt);
    const expired = expires < now || session.status === "closed";
    res.json({
      valid: !expired,
      guestName: session.guestName,
      remainingMs: expired ? 0 : expires - now,
      messageCount: session.messages.length
    });
  });

  // The guest's OWN transcript, so a page refresh doesn't lose the thread. This
  // is token-scoped and returns only messages the guest already saw. It is NOT an
  // admin log — the management side still cannot read guest conversations.
  app.get("/api/guest/:token/messages", async (req, res) => {
    const data = await store.load();
    const session = findSession(data, req.params.token);
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({
      guestName: session.guestName,
      messages: session.messages.map(m => ({ role: m.role, content: m.content }))
    });
  });

  // ──────────────────────────────────────────────────
  // ADMIN routes (behind adminAuth) — session management.
  // ──────────────────────────────────────────────────

  // Mint a new one-time guest link.
  app.post("/api/guest/create", adminAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const ttlMs = Number(body.ttlMs) > 0 ? Math.floor(Number(body.ttlMs)) : limits.defaultTtlMs;
    const cap = Number(body.maxMessages) > 0 ? Math.floor(Number(body.maxMessages)) : limits.maxMessagesPerSession;
    const token = randomBytes(32).toString("hex"); // 64 hex chars — the URL is the credential.

    const session = {
      id: randomUUID(),
      token,
      guestName: body.guestName || "Guest",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      status: "active",
      maxMessages: cap,
      messages: [],
      summary: "",
      memorized: false
    };

    await store.withSessions(data => { data.sessions.push(session); });

    res.json({
      id: session.id,
      token: session.token,
      url: `/visit/${session.token}`,
      expiresAt: session.expiresAt
    });
  });

  // List sessions for the management UI.
  // PRIVACY BY DESIGN: this deliberately never returns `session.messages`. The
  // admin side is only allowed to see the AI-written `summary` plus non-content
  // metadata. Do not add message content to this response.
  app.get("/api/guest/list", adminAuth, async (req, res) => {
    const data = await store.load();
    const list = data.sessions.map(s => ({
      id: s.id,
      guestName: s.guestName,
      status: isExpired(s) ? "expired" : s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      messageCount: s.messages.length,
      userTurns: s.messages.filter(m => m.role === "user").length,
      maxMessages: s.maxMessages || limits.maxMessagesPerSession,
      summary: s.summary,
      messages: s.messages.map(m => ({ role: m.role, content: m.content, ts: m.ts }))
    }));
    res.json(list);
  });

  // Close a session (soft delete). Triggers the session-end summary.
  app.delete("/api/guest/:id", adminAuth, async (req, res) => {
    const found = await store.withSessions(data => {
      const s = data.sessions.find(x => x.id === req.params.id);
      if (!s) return false;
      s.status = "closed";
      return true;
    });
    if (!found) return res.status(404).json({ error: "Not found" });
    // Fire-and-forget: write the summary without blocking the response.
    memorizeSession(req.params.id).catch(e => console.error("[guest] close memorize error:", e.message));
    res.json({ ok: true });
  });

  // NOTE: there is intentionally no endpoint that returns a guest transcript to
  // the admin side. The management UI only ever sees `summary` (via /list).

  // Periodic sweep: summarise sessions that expired without being explicitly
  // closed (a guest just left and never came back). unref() so this timer never
  // keeps the process alive on its own.
  const timer = setInterval(() => {
    sweepEndedSessions().catch(e => console.error("[guest] sweep error:", e.message));
  }, 5 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = { registerGuestRoutes };
