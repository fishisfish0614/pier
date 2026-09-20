"use strict";

// Smoke test — drives the whole guest lifecycle against a real HTTP server,
// using an injected fake LLM (no network, no claude CLI). Uses only Node's
// built-in test runner and global fetch; no test framework, no supertest.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const express = require("express");
const { registerGuestRoutes } = require("../lib/guest-routes");

const FIXED_REPLY = "FAKE_LLM_REPLY_OK";
const RECALL_SENTINEL = "RECALL_MEMORY_BLOCK_MARKER";

test("pier smoke", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pier-test-"));

  // Fake LLM: records what it was asked, returns a fixed string.
  const captured = [];
  const fakeLlm = async ({ system, transcript }) => {
    captured.push({ system, transcript });
    return FIXED_REPLY;
  };

  const app = express();
  function adminAuth(req, res, next) {
    if (req.headers["x-test-admin"] === "ok") return next();
    res.status(401).json({ error: "unauthorized" });
  }

  registerGuestRoutes(app, {
    adminAuth,
    dataDir,
    systemPromptFile: path.join(__dirname, "..", "prompts", "system-prompt.example.md"),
    memorizePromptFile: path.join(__dirname, "..", "prompts", "memorize-prompt.example.md"),
    limits: { maxMessagesPerSession: 50, maxPerMinute: 2, defaultTtlMs: 60 * 60 * 1000 },
    llm: fakeLlm,
    hooks: {
      recall: async ({ guestName }) => RECALL_SENTINEL + " for " + guestName
    }
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const call = async (method, url, opts = {}) => {
    const headers = {};
    if (opts.body) headers["content-type"] = "application/json";
    if (opts.admin) headers["x-test-admin"] = "ok";
    const res = await fetch(base + url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, data };
  };

  await t.test("admin routes require auth", async () => {
    const r = await call("GET", "/api/guest/list");
    assert.strictEqual(r.status, 401);
  });

  let token, id;
  await t.test("create session", async () => {
    const r = await call("POST", "/api/guest/create", { admin: true, body: { guestName: "Sam" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.data.token, "string");
    assert.strictEqual(r.data.token.length, 64);
    assert.strictEqual(r.data.url, "/visit/" + r.data.token);
    token = r.data.token;
    id = r.data.id;
  });

  await t.test("guest sends a message and gets the fake reply", async () => {
    const r = await call("POST", `/api/guest/${token}/chat`, { body: { message: "hello there" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.reply, FIXED_REPLY);
  });

  await t.test("recall hook output is injected into the system prompt", async () => {
    const chatCall = captured.find((c) => c.system.includes(RECALL_SENTINEL));
    assert.ok(chatCall, "recall sentinel should appear in a system prompt handed to the llm");
    assert.ok(chatCall.system.includes("<context>"), "recall output should be wrapped in a <context> block");
  });

  await t.test("per-minute rate limit triggers", async () => {
    // maxPerMinute = 2; one message already went through, so the 2nd is OK and
    // the 3rd is rejected.
    const r2 = await call("POST", `/api/guest/${token}/chat`, { body: { message: "again" } });
    assert.strictEqual(r2.status, 200);
    const r3 = await call("POST", `/api/guest/${token}/chat`, { body: { message: "and again" } });
    assert.strictEqual(r3.status, 429);
  });

  await t.test("closing a session generates a summary", async () => {
    const r = await call("DELETE", `/api/guest/${id}`, { admin: true });
    assert.strictEqual(r.status, 200);

    // memorize is fire-and-forget; poll the admin list until the summary lands.
    let item = null;
    for (let i = 0; i < 100; i++) {
      const list = await call("GET", "/api/guest/list", { admin: true });
      item = list.data.find((s) => s.id === id);
      if (item && item.summary) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(item, "session should appear in the admin list");
    assert.strictEqual(item.summary, FIXED_REPLY, "summary should be the (fake) llm output");
  });

  await t.test("admin list never leaks raw messages", async () => {
    const list = await call("GET", "/api/guest/list", { admin: true });
    assert.ok(Array.isArray(list.data));
    for (const s of list.data) {
      assert.ok(!("messages" in s), "admin list items must not contain a messages array");
    }
  });

  await t.test("guest can still read their own transcript", async () => {
    const r = await call("GET", `/api/guest/${token}/messages`);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.data.messages));
    assert.ok(r.data.messages.some((m) => m.role === "user" && m.content === "hello there"));
  });
});
