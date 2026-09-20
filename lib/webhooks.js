"use strict";

// webhooks.js — inbound pings from friends' services (game tables, etc.).
//
// registerHooks(app, options) mounts POST /hook/:name. Each hook has a secret
// in data/hook_keys.json:  { "bisca": { "key": "<hex>", "hint": "..." } }
// (re-read every request — minting a hook needs no restart).
//
// The caller POSTs JSON; we forward body.text into the owner's harness via its
// local inject endpoint, tagged with the hook name so provenance is always
// visible. We answer 200 immediately (fire-and-forget) — senders only need an
// ack. Everything else in the body is ignored: text is the only field that
// crosses into the owner's context, capped and stringified.

const { readFile, appendFile, mkdir } = require("fs/promises");
const path = require("path");
const http = require("http");

const MAX_TEXT = 6000;

function registerHooks(app, options) {
  options = options || {};
  const express = options.express || require("express");
  const dataDir = options.dataDir || path.join(process.cwd(), "data");
  const keysFile = path.join(dataDir, "hook_keys.json");
  const logFile = path.join(dataDir, "hook_log.jsonl");
  const injectUrl = options.injectUrl || process.env.ROOM_INJECT_URL
    || "http://127.0.0.1:8080/api/inject";

  function inject(tag, text) {
    const body = JSON.stringify({ text, tag, require_alive: false });
    const u = new URL(injectUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 10000
    }, res => { res.resume(); });
    req.on("error", e => console.error("[webhooks] inject failed:", e.message));
    req.on("timeout", () => req.destroy());
    req.end(body);
  }

  app.post("/hook/:name", express.json({ limit: "256kb" }), async (req, res) => {
    const name = String(req.params.name || "");
    let keys = {};
    try { keys = JSON.parse(await readFile(keysFile, "utf-8")); } catch (e) { /* none */ }
    const entry = keys[name];
    const given = String(req.query.key || req.headers["x-hook-key"] || "");
    if (!entry || !given || given !== entry.key) {
      return res.status(401).json({ error: "unauthorized" });
    }
    let text = req.body && req.body.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text (string) required" });
    }
    text = text.trim().slice(0, MAX_TEXT);
    if (entry.hint) text += "\n" + entry.hint;
    try {
      await mkdir(dataDir, { recursive: true });
      await appendFile(logFile, JSON.stringify({
        ts: new Date().toISOString(), hook: name,
        kind: req.body.kind || null, len: text.length }) + "\n");
    } catch (e) { /* logging must never block the ack */ }
    inject(name, text);
    res.json({ ok: true });
  });
}

module.exports = { registerHooks };
