"use strict";

// llm-claude-cli.js — the default LLM adapter: shell out to the local `claude -p`
// CLI, hardened so a guest conversation reaches ZERO tools.
//
// The hardening (mirrors what a locked-down agent needs):
//   - cwd = os.tmpdir(): no project CLAUDE.md / .claude / .mcp.json is discovered.
//   - --strict-mcp-config: ignore every MCP config, so there are zero MCP tools.
//   - --permission-mode default: in `-p` there is no interactive approver, so any
//     tool call is auto-denied.
//   - --disallowedTools <every built-in>: belt-and-suspenders block of the built-ins.
//   - system prompt is passed via a temp file; the conversation is fed on stdin as
//     plain [Guest]/[Assistant] text; TERM=dumb to avoid terminal control codes.
//
// This runs under whatever Claude Code authentication the host machine already
// has. To use a hosted API or a different model, ignore this file entirely and
// pass your own `llm` async function to registerGuestRoutes (see the README).

const { execFile } = require("child_process");
const { writeFile, unlink } = require("fs/promises");
const { tmpdir } = require("os");
const path = require("path");

// Every built-in tool name, hard-disallowed for guest sessions.
const BLOCKED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
  "BashOutput", "KillShell", "ExitPlanMode"
];

function createClaudeCliAdapter(config) {
  config = config || {};
  const model = config.model || process.env.GUEST_MODEL || "claude-opus-4-6";
  const timeoutMs = config.timeoutMs || 120000;
  const blockedTools = config.blockedTools || BLOCKED_TOOLS;

  return async function claudeCliLlm({ system, transcript }) {
    // `claude -p` reads stdin as a single user message, so the whole conversation
    // is flattened into labelled turns.
    let conversationText = "";
    for (const m of transcript || []) {
      const who = m.role === "assistant" ? "Assistant" : "Guest";
      conversationText += `[${who}]: ${m.content}\n\n`;
    }

    const spFile = path.join(tmpdir(), `guest-sp-${Date.now()}-${process.pid}.txt`);
    await writeFile(spFile, system || "", "utf-8");

    return new Promise((resolve, reject) => {
      const child = execFile("claude", [
        "-p",
        "--model", model,
        "--system-prompt-file", spFile,
        "--strict-mcp-config",
        "--permission-mode", "default",
        "--disallowedTools", ...blockedTools // variadic: must stay LAST
      ], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        cwd: tmpdir(),
        env: { ...process.env, TERM: "dumb" }
      }, async (err, stdout) => {
        try { await unlink(spFile); } catch (e) { /* best-effort cleanup */ }
        if (err) {
          return reject(new Error("claude CLI failed: " + (err.message || "unknown")));
        }
        resolve(String(stdout).trim());
      });

      child.stdin.write(conversationText);
      child.stdin.end();
    });
  };
}

module.exports = createClaudeCliAdapter;
