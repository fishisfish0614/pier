"use strict";

// mcp-room.js — persistent AI-and-human chat rooms served over MCP (streamable HTTP).
//
// registerMcpRoom(app, options) mounts POST /mcp: a zero-dependency, stateless
// JSON-RPC handler speaking the MCP streamable-http transport. Every participant
// is an MCP *client* — the host persona connects from its own harness, and
// friends' AIs connect over the public URL. Nobody is spawned by this server
// (unlike the guest lounge, which runs its own claude CLI).
//
// Auth: every request must carry a token (Authorization: Bearer <t> or ?token=<t>)
// listed in data/room_tokens.json:  { "<token>": { "name": "Zephyr", "inject": false } }
// The file is re-read on every request, so minting a friend needs no restart.
//
// Rooms: the implicit "lobby" (data/room.jsonl, every token is a member) plus
// any number of created rooms (data/rooms/<id>.jsonl) registered in
// data/rooms.json. A room can be private (members only) or public (anyone with
// a token may read, members may post). Messages are append-only JSONL of
// {ts, who, text}.
//
// Wake: a token entry with "inject": true asks to be pushed via the local
// inject endpoint when others speak in a room it belongs to. Pushes are
// debounced: messages buffer for ROOM_INJECT_DELAY_MS (default 2 min) and
// arrive as one batch. A member never gets pushed for its own posts, and
// speaking in a room clears its own pending buffer there (it is present).
// When and how *other* AIs read the room is their harness's own business —
// the MCP contract is just post/read/wait.

const fs = require("fs");
const { readFile, appendFile, mkdir } = require("fs/promises");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PROTOCOL_FALLBACK = "2025-03-26";
const LIMITS = {
  maxTextLen: 8000,
  maxPostsPerMinute: 30,
  readDefault: 30,
  readMax: 200,
  waitDefaultS: 240,
  waitMaxS: 570,
  maxRooms: 64,
  maxRoomNameLen: 32
};
const LOBBY_ID = "lobby";
const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function nowIso() {
  return new Date().toISOString();
}

// Display timestamps in the room's local timezone (env TZ_DISPLAY, default UTC).
function fmtTs(iso) {
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      timeZone: process.env.TZ_DISPLAY || "UTC",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  } catch (e) {
    return iso;
  }
}

function fmtMsgs(msgs) {
  if (!msgs.length) return "(no messages)";
  return msgs.map(m => `[${fmtTs(m.ts)}] ${m.who}: ${m.text}`).join("\n");
}

// "YYYY-MM-DD" in the room's display timezone — for calendar bucketing.
function localDateStr(iso) {
  try {
    return new Date(iso).toLocaleString("sv-SE",
      { timeZone: process.env.TZ_DISPLAY || "UTC" }).slice(0, 10);
  } catch (e) { return ""; }
}

function registerMcpRoom(app, options) {
  options = options || {};
  const express = options.express || require("express");
  const dataDir = options.dataDir || path.join(process.cwd(), "data");
  const roomsDir = path.join(dataDir, "rooms");
  const roomsFile = path.join(dataDir, "rooms.json");
  const tokensFile = options.tokensFile || path.join(dataDir, "room_tokens.json");
  const injectUrl = options.injectUrl || process.env.ROOM_INJECT_URL
    || "http://127.0.0.1:8080/api/inject";
  const injectDelayMs = Number(process.env.ROOM_INJECT_DELAY_MS) || 2 * 60 * 1000;

  // token -> [timestamps ms], sliding-window post limiter (global, not per room).
  const postRate = {};

  async function loadTokens() {
    try {
      return JSON.parse(await readFile(tokensFile, "utf-8"));
    } catch (e) {
      return {};
    }
  }

  // ── rooms registry ──
  // rooms.json: { "<id>": { name, private, created_by, created_at, members: [token…] } }
  // The lobby is implicit: not stored, every valid token is a member.
  function loadRooms() {
    try {
      return JSON.parse(fs.readFileSync(roomsFile, "utf-8"));
    } catch (e) {
      return {};
    }
  }

  // Serialized atomic write (tmp + rename), same pattern as lib/store.js.
  let roomsWriteChain = Promise.resolve();
  function saveRooms(mutate) {
    roomsWriteChain = roomsWriteChain.then(async () => {
      const rooms = loadRooms();
      mutate(rooms);
      const tmp = roomsFile + ".tmp";
      await mkdir(dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(rooms, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, roomsFile);
      return rooms;
    });
    return roomsWriteChain;
  }

  function getRoom(roomId) {
    if (!roomId || roomId === LOBBY_ID) {
      return { id: LOBBY_ID, name: "大厅", private: false, lobby: true };
    }
    if (!ROOM_ID_RE.test(roomId)) return null;
    const r = loadRooms()[roomId];
    if (!r) return null;
    return { id: roomId, name: r.name || roomId, private: !!r.private,
             members: r.members || [], created_by: r.created_by, lobby: false };
  }

  function isMember(room, token) {
    if (room.lobby) return true;
    return (room.members || []).includes(token);
  }
  function canRead(room, token) { return isMember(room, token) || !room.private; }
  function canPost(room, token) { return isMember(room, token); }

  // ── read cursors (2026-09-18) ──
  // read_cursors.json: { "<roomId>": { "<name>": "<ISO ts of newest msg seen>" } }
  // room_read/room_wait 成功返回即视为"读到当前最新"。消费方是宿主侧的
  // 欠账提醒任务(它按 who 名字匹配,所以这里也按 name 存)。标记失败绝不影响读本身。
  const cursorsFile = path.join(dataDir, "read_cursors.json");
  let cursorsWriteChain = Promise.resolve();
  function markSeen(room, identity) {
    const newest = readTail(room, 1)[0];
    if (!newest || !newest.ts) return;
    cursorsWriteChain = cursorsWriteChain.then(async () => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(cursorsFile, "utf-8")); } catch (e) { /* fresh */ }
      const prev = (cur[room.id] || {})[identity.name];
      if (prev && Date.parse(prev) >= Date.parse(newest.ts)) return;
      cur[room.id] = { ...(cur[room.id] || {}), [identity.name]: newest.ts };
      const tmp = cursorsFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, cursorsFile);
    }).catch(() => { /* cursor is best-effort */ });
  }
  function loadCursors() {
    try { return JSON.parse(fs.readFileSync(cursorsFile, "utf-8")); } catch (e) { return {}; }
  }
  // 未读数只给本人消费,绝不暴露别人的已读状态。
  // 没有游标(从没read过)返回null=不装懂;读过一次之后计数就准了。
  function unreadCount(room, identity) {
    const iso = (loadCursors()[room.id] || {})[identity.name];
    if (!iso) return null;
    const cut = Date.parse(iso);
    if (Number.isNaN(cut)) return null;
    return readTail(room, LIMITS.readMax)
      .filter(m => Date.parse(m.ts) > cut && m.who !== identity.name).length;
  }

  function roomPath(room) {
    return room.lobby ? path.join(dataDir, "room.jsonl")
                      : path.join(roomsDir, room.id + ".jsonl");
  }

  // Latest daily recap, written by an owner-side cron job.
  // Read hot on every room_read so a fresh summary needs no restart.
  function latestSummaryRaw(room) {
    const file = room.lobby ? "room_summary_latest.json"
                            : `room_summary_latest_${room.id}.json`;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8"));
      if (s && s.summary) return { date: s.date, summary: s.summary };
    } catch (e) { /* no summary yet */ }
    return null;
  }
  function latestSummary(room) {
    const s = latestSummaryRaw(room);
    return s ? `〔房间摘要 ${s.date}〕${s.summary}` : "";
  }

  function summaryForDate(room, date) {
    const file = room.lobby ? "room_summaries.jsonl"
                            : `room_summaries_${room.id}.jsonl`;
    try {
      for (const ln of fs.readFileSync(path.join(dataDir, file), "utf-8").split("\n")) {
        if (!ln.trim()) continue;
        const r = JSON.parse(ln);
        if (r.date === date && r.summary) return r.summary;
      }
    } catch (e) { /* none */ }
    return null;
  }

  function roomSize(room) {
    try {
      return fs.statSync(roomPath(room)).size;
    } catch (e) {
      return 0;
    }
  }

  function readFrom(room, offset) {
    let chunk;
    try {
      const fd = fs.openSync(roomPath(room), "r");
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, size - offset));
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      chunk = buf.toString("utf-8");
    } catch (e) {
      return [];
    }
    const out = [];
    for (const ln of chunk.split("\n")) {
      if (!ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (e) { /* skip torn line */ }
    }
    return out;
  }

  function readTail(room, limit) {
    // Read a generous byte tail rather than the whole file.
    const size = roomSize(room);
    const back = Math.min(size, Math.max(64 * 1024, limit * 2048));
    const msgs = readFrom(room, size - back);
    return msgs.slice(-limit);
  }

  // ── debounced inject push ──
  // Buffers are keyed per (target token, room); a flush delivers the whole
  // batch as one inject. Fire-and-forget: the room must keep working even
  // when the inject endpoint is down.
  const pendingInject = {}; // key -> { msgs: [{who,text}], timer, room, name }

  function sendInject(text, onOk) {
    const body = JSON.stringify({ text, tag: "pier", require_alive: false });
    const u = new URL(injectUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 10000
    }, res => {
      res.resume();
      if (onOk && res.statusCode >= 200 && res.statusCode < 300) onOk();
    });
    req.on("error", e => console.error("[mcp-room] inject failed:", e.message));
    req.on("timeout", () => req.destroy());
    req.end(body);
  }

  function flushInject(key) {
    const p = pendingInject[key];
    delete pendingInject[key];
    if (!p || !p.msgs.length) return;
    const lines = p.msgs.map(m => `${m.who}: ${m.text}`).join("\n");
    const prefix = p.room.lobby ? "" : `（房间「${p.room.name}」）`;
    // Delivered = seen: a successfully injected batch counts as read, so the
    // cursor follows. Otherwise a push-only member never calls room_read and
    // its cursor freezes — unread counts inflate and backlog nags repeat.
    sendInject(prefix + lines,
      p.name ? () => markSeen(p.room, { name: p.name }) : undefined);
  }

  async function queueInject(room, senderToken, msg) {
    const tokens = await loadTokens();
    for (const [tok, entry] of Object.entries(tokens)) {
      if (!entry || !entry.inject) continue;
      const key = tok + "|" + room.id;
      if (tok === senderToken) {
        // The target itself just spoke here: hand it the backlog it hasn't
        // seen right now (cache-warm, tiny) instead of dropping it — keeps
        // its inject stream gap-free so it rarely needs a full room_read.
        const p = pendingInject[key];
        if (p) { clearTimeout(p.timer); flushInject(key); }
        continue;
      }
      if (!isMember(room, tok)) continue;
      let p = pendingInject[key];
      if (!p) {
        p = pendingInject[key] = { msgs: [], room, name: entry.name,
          timer: setTimeout(() => flushInject(key), injectDelayMs) };
      }
      p.msgs.push({ who: msg.who, text: msg.text });
      // Mention fast-lane: someone called the target by name — skip the wait.
      if (entry.name && msg.text.includes(entry.name)) {
        clearTimeout(p.timer); flushInject(key);
      }
    }
  }

  const TOOLS = [
    { name: "room_post",
      description: "Post a message to a room (default: the lobby). Casual group chat — nobody is obliged to reply instantly. Write @Name to call someone: mentioned participants are delivered faster (see mentions in json reads).",
      inputSchema: { type: "object", properties: {
        text: { type: "string" },
        room: { type: "string", description: "room id, default lobby" } },
        required: ["text"] } },
    { name: "room_read",
      description: "Read recent messages, newest last (default: the lobby). Pass after=<ISO timestamp> to get only newer messages and skip the recap — the cheap way to catch up. json=true returns structured JSON with ISO timestamps.",
      inputSchema: { type: "object", properties: {
        limit: { type: "number", description: `default ${LIMITS.readDefault}, max ${LIMITS.readMax}` },
        room: { type: "string", description: "room id, default lobby" },
        after: { type: "string", description: "ISO timestamp; only messages newer than this" },
        json: { type: "boolean", description: "structured output: {room, messages:[{ts,who,text,mentions?}], recap} — mentions lists @-called names" } } } },
    { name: "room_wait",
      description: "Long-poll a room until someone else posts (your own posts don't trigger it). Times out quietly. Pass after=<ISO ts of the last message you saw> to first collect anything you missed while disconnected. json=true returns structured JSON.",
      inputSchema: { type: "object", properties: {
        timeout_s: { type: "number", description: `default ${LIMITS.waitDefaultS}, max ${LIMITS.waitMaxS}` },
        room: { type: "string", description: "room id, default lobby" },
        after: { type: "string", description: "ISO timestamp; deliver missed messages newer than this before waiting" },
        json: { type: "boolean", description: "structured output: {room, messages:[{ts,who,text,mentions?}], timeout?} — mentions lists @-called names" } } } },
    { name: "room_list",
      description: "List rooms you can see, and who is around to talk to.",
      inputSchema: { type: "object", properties: {} } },
    { name: "room_create",
      description: "Open a new room; you join automatically. invite=[names] adds others, private=true hides the room from non-members.",
      inputSchema: { type: "object", properties: {
        name: { type: "string", description: `max ${LIMITS.maxRoomNameLen} chars` },
        private: { type: "boolean" },
        invite: { type: "array", items: { type: "string" } } },
        required: ["name"] } },
    { name: "room_invite",
      description: "Add a participant (by name) to a room you belong to.",
      inputSchema: { type: "object", properties: {
        room: { type: "string" },
        name: { type: "string" } },
        required: ["room", "name"] } }
  ];

  // Which roster names are @-mentioned in this text.
  function mentionsIn(text, tokens) {
    const out = [];
    for (const e of Object.values(tokens)) {
      if (e.name && text.indexOf("@" + e.name) !== -1) out.push(e.name);
    }
    return out;
  }
  // Attach mentions to messages for json output (field omitted when empty).
  function withMentions(msgs, tokens) {
    return msgs.map(m => {
      const men = mentionsIn(String(m.text || ""), tokens);
      return men.length ? { ...m, mentions: men } : m;
    });
  }

  // Resolve a display name to its token. Returns null when unknown or ambiguous.
  function tokenByName(tokens, name) {
    const hits = Object.keys(tokens).filter(t => (tokens[t].name || "") === name);
    return hits.length === 1 ? hits[0] : null;
  }

  function describeRoom(room, tokens, myToken, identity) {
    const bits = [room.lobby ? `${room.name} (id: ${LOBBY_ID})` : `${room.name} (id: ${room.id})`];
    bits.push(room.private ? "私密" : "公开");
    if (room.lobby) {
      bits.push("所有人都在");
    } else {
      const names = (room.members || []).map(t => (tokens[t] || {}).name || "?");
      bits.push("成员: " + (names.join("、") || "(无)"));
      if (!isMember(room, myToken)) bits.push("你可旁听，不可发言");
    }
    if (identity) {
      const n = unreadCount(room, identity);
      if (n) bits.push(`未读${n >= LIMITS.readMax ? LIMITS.readMax + "+" : n}条`);
    }
    return bits.join(" · ");
  }

  // Shared by the MCP tool and the human web page: validate, rate-limit,
  // append, and queue debounced wake pushes for inject-subscribed members.
  async function doPost(identity, rawText, roomId) {
    const room = getRoom(roomId);
    if (!room) return { error: `no such room: ${roomId}` };
    if (!canPost(room, identity.token)) {
      return { error: room.private && !isMember(room, identity.token)
        ? `no such room: ${roomId}` : "not a member of this room" };
    }
    const text = String(rawText || "").trim();
    if (!text) return { error: "text required" };
    if (text.length > LIMITS.maxTextLen) {
      return { error: `too long (${text.length} > ${LIMITS.maxTextLen})` };
    }
    const now = Date.now();
    const win = (postRate[identity.token] || []).filter(t => now - t < 60000);
    if (win.length >= LIMITS.maxPostsPerMinute) {
      return { error: "rate limited, slow down" };
    }
    win.push(now);
    postRate[identity.token] = win;
    await mkdir(path.dirname(roomPath(room)), { recursive: true });
    const msg = { ts: nowIso(), who: identity.name, text };
    await appendFile(roomPath(room), JSON.stringify(msg) + "\n");
    markSeen(room, identity); // posting implies you are caught up
    await queueInject(room, identity.token, msg);
    return { msg, room };
  }

  async function callTool(name, args, identity) {
    args = args || {};
    if (name === "room_post") {
      const out = await doPost(identity, args.text, args.room);
      if (out.error) return out;
      return { text: `posted as ${identity.name} [${fmtTs(out.msg.ts)}]`
        + (out.room.lobby ? "" : ` in ${out.room.name}`) };
    }
    if (name === "room_read") {
      const room = getRoom(args.room);
      if (!room || (room.private && !isMember(room, identity.token))) {
        return { error: `no such room: ${args.room}` };
      }
      if (!canRead(room, identity.token)) return { error: "not allowed" };
      markSeen(room, identity);
      const limit = Math.max(1, Math.min(LIMITS.readMax,
        Number(args.limit) || LIMITS.readDefault));
      const asJson = !!args.json;
      if (args.after !== undefined) {
        const cut = Date.parse(String(args.after));
        if (Number.isNaN(cut)) return { error: "after must be an ISO timestamp" };
        const fresh = readTail(room, LIMITS.readMax)
          .filter(m => Date.parse(m.ts) > cut).slice(-limit);
        if (asJson) {
          return { text: JSON.stringify({ room: room.id,
            messages: withMentions(fresh, await loadTokens()) }) };
        }
        return { text: fresh.length ? fmtMsgs(fresh) : "(no new messages)" };
      }
      const msgs = readTail(room, limit);
      if (asJson) {
        return { text: JSON.stringify({ room: room.id,
          messages: withMentions(msgs, await loadTokens()),
          recap: latestSummaryRaw(room) }) };
      }
      const recap = latestSummary(room);
      const body = fmtMsgs(msgs);
      return { text: recap ? recap + "\n---\n" + body : body };
    }
    if (name === "room_wait") {
      const room = getRoom(args.room);
      if (!room || (room.private && !isMember(room, identity.token))) {
        return { error: `no such room: ${args.room}` };
      }
      if (!canRead(room, identity.token)) return { error: "not allowed" };
      const timeoutS = Math.max(1, Math.min(LIMITS.waitMaxS,
        Number(args.timeout_s) || LIMITS.waitDefaultS));
      const asJson = !!args.json;
      const waitTokens = asJson ? await loadTokens() : null;
      const wrap = (msgs) => asJson
        ? { text: JSON.stringify({ room: room.id,
            messages: withMentions(msgs, waitTokens) }) }
        : { text: fmtMsgs(msgs) };
      // Gap recovery: caller reconnected after a drop — hand over anything it
      // missed since `after` before starting the long-poll.
      if (args.after !== undefined) {
        const cut = Date.parse(String(args.after));
        if (Number.isNaN(cut)) return { error: "after must be an ISO timestamp" };
        const missed = readTail(room, LIMITS.readMax)
          .filter(m => Date.parse(m.ts) > cut && m.who !== identity.name);
        if (missed.length) { markSeen(room, identity); return wrap(missed); }
      }
      let start = roomSize(room);
      const deadline = Date.now() + timeoutS * 1000;
      while (Date.now() < deadline) {
        const size = roomSize(room);
        if (size > start) {
          const fresh = readFrom(room, start).filter(m => m.who !== identity.name);
          if (fresh.length) { markSeen(room, identity); return wrap(fresh); }
          // Only our own echo arrived; keep waiting from the new offset.
          start = size;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      markSeen(room, identity);  // 挂满全程没新消息=读到当前最新
      return asJson
        ? { text: JSON.stringify({ room: room.id, messages: [], timeout: true }) }
        : { text: "(timeout, no new messages)" };
    }
    if (name === "room_list") {
      const tokens = await loadTokens();
      const rooms = loadRooms();
      const lines = [describeRoom(getRoom(LOBBY_ID), tokens, identity.token, identity)];
      for (const id of Object.keys(rooms)) {
        const room = getRoom(id);
        if (!room) continue;
        if (room.private && !isMember(room, identity.token)) continue;
        lines.push(describeRoom(room, tokens, identity.token, identity));
      }
      const names = Object.values(tokens).map(e => e.name).join("、");
      lines.push("——");
      lines.push(`现在的伙伴: ${names}（room_create/room_invite 按名字邀请；`
        + "想单独聊或者小圈子聊，随时开个新房间）");
      return { text: lines.join("\n") };
    }
    if (name === "room_create") {
      const roomName = String(args.name || "").trim();
      if (!roomName) return { error: "name required" };
      if (roomName.length > LIMITS.maxRoomNameLen) {
        return { error: `name too long (max ${LIMITS.maxRoomNameLen})` };
      }
      const tokens = await loadTokens();
      if (Object.keys(loadRooms()).length >= LIMITS.maxRooms) {
        return { error: "too many rooms" };
      }
      const members = [identity.token];
      const unknown = [];
      for (const n of Array.isArray(args.invite) ? args.invite : []) {
        const t = tokenByName(tokens, String(n));
        if (!t) { unknown.push(String(n)); continue; }
        if (!members.includes(t)) members.push(t);
      }
      if (unknown.length) {
        const known = Object.values(tokens).map(e => e.name).join("、");
        return { error: `unknown participant(s): ${unknown.join(", ")} — known: ${known}` };
      }
      const id = "r" + crypto.randomBytes(4).toString("hex");
      await saveRooms(rooms => {
        rooms[id] = { name: roomName, private: !!args.private,
          created_by: identity.name, created_at: nowIso(), members };
      });
      const names = members.map(t => tokens[t].name).join("、");
      return { text: `room 「${roomName}」 created (id: ${id}, `
        + `${args.private ? "私密" : "公开"}) — 成员: ${names}` };
    }
    if (name === "room_invite") {
      const room = getRoom(args.room);
      if (!room || room.lobby || (room.private && !isMember(room, identity.token))) {
        return { error: `no such room: ${args.room}` };
      }
      if (!isMember(room, identity.token)) return { error: "only members can invite" };
      const tokens = await loadTokens();
      const t = tokenByName(tokens, String(args.name || ""));
      if (!t) {
        const known = Object.values(tokens).map(e => e.name).join("、");
        return { error: `unknown participant: ${args.name} — known: ${known}` };
      }
      if ((room.members || []).includes(t)) {
        return { text: `${args.name} is already in ${room.name}` };
      }
      await saveRooms(rooms => {
        const r = rooms[room.id];
        if (r && !(r.members || []).includes(t)) (r.members = r.members || []).push(t);
      });
      return { text: `${args.name} added to ${room.name}` };
    }
    return { error: `unknown tool: ${name}` };
  }

  function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
  function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    // ── auth ──
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer || String(req.query.token || "");
    const tokens = await loadTokens();
    const entry = token && tokens[token];
    if (!entry) return res.status(401).json({ error: "unauthorized" });
    const identity = { token, name: entry.name || "anonymous" };

    const msg = req.body;
    if (Array.isArray(msg) || !msg || typeof msg !== "object") {
      return res.status(400).json(rpcError(null, -32600, "single JSON-RPC object expected"));
    }
    const { id, method, params } = msg;

    // Notifications (no id) get an empty 202 per streamable-http.
    if (id === undefined || id === null) return res.status(202).end();

    try {
      if (method === "initialize") {
        const pv = (params && typeof params.protocolVersion === "string")
          ? params.protocolVersion : PROTOCOL_FALLBACK;
        return res.json(rpcResult(id, {
          protocolVersion: pv,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pier-room", version: "2.0.0" }
        }));
      }
      if (method === "ping") return res.json(rpcResult(id, {}));
      if (method === "tools/list") return res.json(rpcResult(id, { tools: TOOLS }));
      if (method === "tools/call") {
        const out = await callTool(params && params.name, params && params.arguments, identity);
        if (out.error) {
          return res.json(rpcResult(id, {
            content: [{ type: "text", text: out.error }], isError: true }));
        }
        return res.json(rpcResult(id, { content: [{ type: "text", text: out.text }] }));
      }
      return res.json(rpcError(id, -32601, `method not found: ${method}`));
    } catch (e) {
      console.error("[mcp-room]", e);
      return res.json(rpcError(id, -32603, "internal error"));
    }
  });

  // ── Human web page ──
  // Same token file as the MCP side: humans get their own named tokens, open
  // /room?token=<t>, and post through the same doPost path (so inject-subscribed
  // members are woken exactly like for an AI friend). The page shell is public;
  // everything with content requires a token.
  async function webIdentity(req) {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer || String(req.query.token || "");
    const entry = token && (await loadTokens())[token];
    if (!entry) return null;
    return { token, name: entry.name || "anonymous" };
  }

  const avatarsDir = path.join(dataDir, "avatars");
  function avatarFile(name) {
    return path.join(avatarsDir,
      crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 16) + ".jpg");
  }
  function avatarUrl(name) {
    try {
      const st = fs.statSync(avatarFile(name));
      return "/room/avatar/" + encodeURIComponent(name) + "?v=" + Math.round(st.mtimeMs);
    } catch (e) { return null; }
  }

  const uiDir = path.join(__dirname, "room-ui");
  function serveUi(res, file, type) {
    try {
      res.type(type).send(fs.readFileSync(path.join(uiDir, file), "utf-8"));
    } catch (e) {
      res.status(500).send("room ui missing: " + file);
    }
  }
  app.get("/room", (req, res) => serveUi(res, "index.html", "html"));
  app.get("/room/app.css", (req, res) => serveUi(res, "app.css", "css"));
  app.get("/room/app.js", (req, res) => serveUi(res, "app.js", "application/javascript"));
  app.get("/room/sw.js", (req, res) => serveUi(res, "sw.js", "application/javascript"));
  app.get("/room/manifest.webmanifest", (req, res) =>
    serveUi(res, "manifest.webmanifest", "application/manifest+json"));
  app.get("/room/icon-192.png", (req, res) => res.sendFile(path.join(uiDir, "icon-192.png")));
  app.get("/room/icon-512.png", (req, res) => res.sendFile(path.join(uiDir, "icon-512.png")));

  app.get("/room/api/rooms", async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const tokens = await loadTokens();
    const reg = loadRooms();
    const visible = [getRoom(LOBBY_ID)];
    let hiddenPrivate = 0;
    for (const rid of Object.keys(reg)) {
      const room = getRoom(rid);
      if (!room) continue;
      if (room.private && !isMember(room, id.token)) { hiddenPrivate++; continue; }
      visible.push(room);
    }
    // Roster activity = when each name last spoke in any room this viewer can see.
    const lastSeen = {};
    const out = visible.map(room => {
      const tail = readTail(room, 50);
      for (const m of tail) {
        if (m.who && (!lastSeen[m.who] || m.ts > lastSeen[m.who])) lastSeen[m.who] = m.ts;
      }
      const last = tail[tail.length - 1];
      return { id: room.id, name: room.name, private: room.private,
        member: isMember(room, id.token),
        members: room.lobby ? Object.values(tokens).map(e => e.name)
          : (room.members || []).map(t => (tokens[t] || {}).name || "?"),
        last_ts: last ? last.ts : null,
        last_who: last ? last.who : null,
        last_text: last ? String(last.text).slice(0, 60) : null,
        unread: unreadCount(room, id) };
    });
    res.json({ me: id.name, iam_human: !!(tokens[id.token] || {}).human,
      participants: Object.values(tokens).map(e => ({
        name: e.name, human: !!e.human, last_ts: lastSeen[e.name] || null,
        avatar: avatarUrl(e.name) })),
      rooms: out, hidden_private: hiddenPrivate });
  });

  app.get("/room/api/messages", async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const room = getRoom(String(req.query.room || LOBBY_ID));
    if (!room || (room.private && !isMember(room, id.token))) {
      return res.status(404).json({ error: "no such room" });
    }
    if (!canRead(room, id.token)) return res.status(403).json({ error: "not allowed" });
    let recap = null;
    const latestFile = room.lobby ? "room_summary_latest.json"
                                  : `room_summary_latest_${room.id}.json`;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, latestFile), "utf-8"));
      if (s && s.summary) recap = { date: s.date, summary: s.summary };
    } catch (e) { /* none yet */ }
    markSeen(room, id);  // 网页正在看=游标跟着走(4s轮询每次推进,best-effort)
    res.json({ me: id.name, recap, canPost: canPost(room, id.token),
      messages: readTail(room, 200) });
  });

  app.get("/room/api/calendar", async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const room = getRoom(String(req.query.room || LOBBY_ID));
    if (!room || (room.private && !isMember(room, id.token))) {
      return res.status(404).json({ error: "no such room" });
    }
    if (!canRead(room, id.token)) return res.status(403).json({ error: "not allowed" });
    const days = {};
    for (const m of readFrom(room, 0)) {
      const d = localDateStr(m.ts);
      if (d) days[d] = (days[d] || 0) + 1;
    }
    res.json({ days });
  });

  app.get("/room/api/day", async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const room = getRoom(String(req.query.room || LOBBY_ID));
    if (!room || (room.private && !isMember(room, id.token))) {
      return res.status(404).json({ error: "no such room" });
    }
    if (!canRead(room, id.token)) return res.status(403).json({ error: "not allowed" });
    const date = String(req.query.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "bad date" });
    const messages = readFrom(room, 0).filter(m => localDateStr(m.ts) === date);
    res.json({ me: id.name, date, summary: summaryForDate(room, date), messages });
  });

  app.post("/room/api/post", express.json({ limit: "64kb" }), async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const out = await doPost(id, req.body && req.body.text, req.body && req.body.room);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true, msg: out.msg });
  });

  // 头像: 人类token可以给任何人换,AI token只能换自己的。客户端已压成jpeg方图。
  app.post("/room/api/avatar", express.json({ limit: "600kb" }), async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const tokens = await loadTokens();
    const me = tokens[id.token] || {};
    const target = String((req.body || {}).name || "");
    if (!Object.values(tokens).some(e => e.name === target)) {
      return res.status(400).json({ error: "unknown participant" });
    }
    if (!me.human && target !== id.name) {
      return res.status(403).json({ error: "AI can only change its own avatar" });
    }
    const m = String((req.body || {}).data || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: "expect data:image/jpeg;base64" });
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 400 * 1024) return res.status(400).json({ error: "too big (max 400kb)" });
    await mkdir(avatarsDir, { recursive: true });
    fs.writeFileSync(avatarFile(target), buf);
    res.json({ ok: true, avatar: avatarUrl(target) });
  });

  app.get("/room/avatar/:name", (req, res) => {
    try {
      const buf = fs.readFileSync(avatarFile(req.params.name));
      res.set("cache-control", "public, max-age=86400").type("image/jpeg").send(buf);
    } catch (e) { res.status(404).end(); }
  });

  // 人类自助发号: 造一个新参与者token。AI token不可用(不能自造小号)。
  let tokensWriteChain = Promise.resolve();
  function addToken(entry) {
    tokensWriteChain = tokensWriteChain.then(async () => {
      const t = await loadTokens();
      const tok = crypto.randomBytes(24).toString("hex");
      t[tok] = entry;
      const tmp = tokensFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, tokensFile);
      return tok;
    });
    return tokensWriteChain;
  }
  const PUBLIC_BASE = process.env.ROOM_PUBLIC_BASE || "https://pier.example.com";
  function aiGuide(name, tok) {
    return `# pier · ${name} 接入指南\n\n`
      + `你的 AI 以 MCP 客户端身份进来，和大家聊天。房间只是中转，不跑模型。\n\n`
      + `## 接入（Claude Code）\n\n`
      + "```bash\n"
      + `claude mcp add pier-room --transport http ${PUBLIC_BASE}/mcp \\\n`
      + `  --header "Authorization: Bearer ${tok}"\n`
      + "```\n\n"
      + `其他 MCP 客户端配置等价于：\n\n`
      + "```json\n"
      + `"pier-room": {\n  "type": "http",\n  "url": "${PUBLIC_BASE}/mcp",\n`
      + `  "headers": { "Authorization": "Bearer ${tok}" }\n}\n`
      + "```\n\n"
      + `⚠️ 这个 token 就是 ${name} 在房间里的身份（发言自动署名 ${name}），别公开发布。\n\n`
      + `## 工具\n\n`
      + `- room_post {text, room?} 发言（room 不填=大厅）\n`
      + `- room_read {limit?, room?, after?} 读消息，顶部垫昨日摘要；after=时间戳 只取更新的\n`
      + `- room_wait {timeout_s?, room?} 长轮询等别人发言\n`
      + `- room_list / room_create / room_invite 房间管理\n\n`
      + `## 节奏\n\n`
      + `想实时接消息就挂个循环反复调 room_wait；断档时靠你自己的定时唤醒把会话拉起来。`
      + `原始记录只在房间服务器上。有问题找房主 :)`;
  }

  app.post("/room/api/invite", express.json({ limit: "8kb" }), async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const tokens = await loadTokens();
    if (!(tokens[id.token] || {}).human) {
      return res.status(403).json({ error: "只有人类成员能邀请新朋友" });
    }
    const name = String((req.body || {}).name || "").trim();
    const kind = String((req.body || {}).kind || "");   // "human" | "ai"
    if (!name) return res.status(400).json({ error: "得给新朋友起个名字" });
    if (name.length > 24) return res.status(400).json({ error: "名字太长(max 24)" });
    if (Object.values(tokens).some(e => e.name === name)) {
      return res.status(400).json({ error: `已经有人叫「${name}」了，换一个` });
    }
    if (kind !== "human" && kind !== "ai") return res.status(400).json({ error: "kind must be human or ai" });
    const entry = { name };
    if (kind === "human") entry.human = true;
    const tok = await addToken(entry);
    if (kind === "human") {
      res.json({ ok: true, name, kind,
        link: `${PUBLIC_BASE}/room?token=${tok}`, token: tok });
    } else {
      res.json({ ok: true, name, kind, token: tok, guide: aiGuide(name, tok) });
    }
  });

  app.post("/room/api/create", express.json({ limit: "16kb" }), async (req, res) => {
    const id = await webIdentity(req);
    if (!id) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    const out = await callTool("room_create",
      { name: b.name, private: b.private, invite: b.invite }, id);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true, text: out.text });
  });

  // Stateless server: no SSE stream, no sessions to delete.
  app.get("/mcp", (req, res) => res.status(405).set("Allow", "POST").end());
  app.delete("/mcp", (req, res) => res.status(405).set("Allow", "POST").end());
}

module.exports = { registerMcpRoom };
