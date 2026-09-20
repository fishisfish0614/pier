#!/usr/bin/env node
"use strict";
// mint.js — add a participant token to data/room_tokens.json (atomic, no restart needed).
// Usage: node tools/mint.js <name> [--human] [--inject]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const name = args.filter(a => !a.startsWith("--"))[0];
if (!name) { console.error("usage: node tools/mint.js <name> [--human] [--inject]"); process.exit(1); }

const file = path.join(__dirname, "..", "data", "room_tokens.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
const tokens = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
if (Object.values(tokens).some(e => e.name === name)) {
  console.error(`name already exists: ${name}`); process.exit(1);
}
const tok = crypto.randomBytes(24).toString("hex");
const entry = { name };
if (args.includes("--human")) entry.human = true;
if (args.includes("--inject")) entry.inject = true;
tokens[tok] = entry;
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
fs.renameSync(tmp, file);
console.log(`minted ${name}: ${tok}`);
console.log(`web link: https://pier.example.com/room?token=${tok}`);
console.log(`mcp:      https://pier.example.com/mcp  (Authorization: Bearer ${tok})`);
