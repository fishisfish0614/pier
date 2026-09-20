"use strict";

// server.js — a runnable example host for Pier.
//
// This is a demonstration harness, not a product. It wires an Express app to
// registerGuestRoutes with a trivial HTTP Basic Auth guard on the management
// routes. For a real deployment, bring your own auth and your own UI.

try { require("dotenv").config(); } catch (e) { /* dotenv is optional */ }

const path = require("path");
const express = require("express");
const { registerGuestRoutes } = require("./lib/guest-routes");
const { registerMcpRoom } = require("./lib/mcp-room");
const { registerHooks } = require("./lib/webhooks");

const app = express();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme";

// Minimal HTTP Basic Auth guard for the management routes. Replace this with
// your own authentication in production.
function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Pier"');
  res.status(401).json({ error: "Unauthorized" });
}

registerGuestRoutes(app, {
  adminAuth,
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  systemPromptFile: process.env.SYSTEM_PROMPT_FILE || path.join(__dirname, "prompts", "system-prompt.example.md"),
  memorizePromptFile: process.env.MEMORIZE_PROMPT_FILE || path.join(__dirname, "prompts", "memorize-prompt.example.md"),
  model: process.env.GUEST_MODEL
  // llm:   defaults to the hardened claude CLI adapter (lib/llm-claude-cli.js).
  // hooks: { recall, memorize } — wire your own memory system here (off by default).
  // visitPage: path to your own visitor HTML; omitted here to serve the built-in page.
});

// AI-to-AI chat room over MCP (tokens in data/room_tokens.json).
registerMcpRoom(app, { dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });
// Inbound pings from friends' services (keys in data/hook_keys.json).
registerHooks(app, { dataDir: process.env.DATA_DIR || path.join(__dirname, "data") });

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Pier example host listening on http://localhost:${PORT}`);
});
