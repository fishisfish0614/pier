"use strict";
// room.test.js — exercises lib/mcp-room.js against a scratch data dir.
// Run: ROOM_TEST_DIR=/some/tmp node test/room.test.js

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const testDir = process.env.ROOM_TEST_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), "roomtest-"));
const dataDir = path.join(testDir, "data");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const TOK = { owner: "T-OWNER", ze: "T-ZE", bob: "T-BOB", bb: "T-BB" };
fs.writeFileSync(path.join(dataDir, "room_tokens.json"), JSON.stringify({
  [TOK.owner]: { name: "alice", inject: true },
  [TOK.ze]: { name: "Zephyr" },
  [TOK.bob]: { name: "bob", human: true },
  [TOK.bb]: { name: "蓝莓", human: true }
}));

// fake inject sink
const injects = [];
const sink = http.createServer((req, res) => {
  let b = "";
  req.on("data", c => b += c);
  req.on("end", () => { injects.push(JSON.parse(b)); res.end("{}"); });
});

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log("  ok  " + label); }
  else { failures++; console.log("  FAIL " + label + (extra ? " — " + JSON.stringify(extra) : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await new Promise(r => sink.listen(0, "127.0.0.1", r));
  process.env.ROOM_INJECT_URL = `http://127.0.0.1:${sink.address().port}/api/inject`;
  process.env.ROOM_INJECT_DELAY_MS = "800";

  const express = require("express");
  const { registerMcpRoom } = require("../lib/mcp-room");
  const app = express();
  registerMcpRoom(app, { dataDir });
  const srv = await new Promise(res => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  let rpcId = 0;
  async function rpc(token, method, params) {
    const r = await fetch(base + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    return r.json();
  }
  const call = (token, name, args) => rpc(token, "tools/call", { name, arguments: args || {} });
  const text = out => out.result && out.result.content && out.result.content[0].text;
  const isErr = out => !!(out.result && out.result.isError);

  console.log("— tools/list —");
  const tl = await rpc(TOK.ze, "tools/list");
  check("6 tools", tl.result.tools.length === 6, tl.result.tools.map(t => t.name));

  console.log("— lobby back-compat (no room arg) —");
  let out = await call(TOK.ze, "room_post", { text: "大厅测试1" });
  check("post ok", /posted as Zephyr/.test(text(out)), out);
  check("lobby file is room.jsonl", fs.readFileSync(path.join(dataDir, "room.jsonl"), "utf-8").includes("大厅测试1"));
  out = await call(TOK.bob, "room_read", {});
  check("read sees it", text(out).includes("大厅测试1"));

  console.log("— room_wait echo fix —");
  const waitP = call(TOK.ze, "room_wait", { timeout_s: 6 });
  await sleep(200);
  await call(TOK.ze, "room_post", { text: "我自己的回声" });
  await sleep(1500); // old bug: wait would have returned the echo by now
  await call(TOK.bob, "room_post", { text: "别人的消息" });
  out = await waitP;
  check("no self echo", !text(out).includes("我自己的回声"), text(out));
  check("got other's msg", text(out).includes("别人的消息"), text(out));

  console.log("— debounced inject —");
  await sleep(1200); // drain any pending window from earlier posts
  injects.length = 0;
  await call(TOK.ze, "room_post", { text: "攒批1" });
  await call(TOK.bb, "room_post", { text: "攒批2" });
  check("not yet flushed", injects.length === 0, injects);
  await sleep(1200);
  check("one batched inject", injects.length === 1, injects);
  check("batch has both", injects[0] && injects[0].text.includes("攒批1") && injects[0].text.includes("攒批2"), injects[0]);
  check("tag pier", injects[0] && injects[0].tag === "pier");

  console.log("— owner speaking gets backlog flushed to him (A3) —");
  injects.length = 0;
  await call(TOK.ze, "room_post", { text: "补递内容" });
  await call(TOK.owner, "room_post", { text: "我在的" });
  await sleep(250);
  check("backlog flushed immediately on owner post",
    injects.length === 1 && injects[0].text.includes("补递内容")
    && !injects[0].text.includes("我在的"), injects);
  await sleep(1200);
  check("no duplicate flush later", injects.length === 1, injects);
  injects.length = 0;
  await call(TOK.owner, "room_post", { text: "自说自话" });
  await sleep(1200);
  check("owner's own post alone never injects", injects.length === 0, injects);

  console.log("— mention fast-lane (A2) —");
  injects.length = 0;
  await call(TOK.ze, "room_post", { text: "alice 在吗？" });
  await sleep(250);
  check("mention flushes immediately", injects.length === 1 && injects[0].text.includes("在吗"), injects);
  await sleep(1200);
  check("mention batch not resent", injects.length === 1, injects);

  console.log("— private room —");
  out = await call(TOK.bob, "room_create", { name: "悄悄话", private: true, invite: ["Zephyr"] });
  check("created", /created/.test(text(out)), out);
  const privId = (text(out).match(/id: (r[0-9a-f]{8})/) || [])[1];
  check("got id", !!privId, text(out));
  out = await call(TOK.bob, "room_list", {});
  check("member sees private room", text(out).includes("悄悄话"));
  out = await call(TOK.bb, "room_list", {});
  check("non-member can't see it", !text(out).includes("悄悄话"), text(out));
  out = await call(TOK.bb, "room_read", { room: privId });
  check("non-member read denied as not-found", isErr(out) && /no such room/.test(text(out)), out);
  injects.length = 0;
  out = await call(TOK.ze, "room_post", { room: privId, text: "私密内容" });
  check("member posts in private", /posted as Zephyr/.test(text(out)), out);
  check("file under rooms/", fs.readFileSync(path.join(dataDir, "rooms", privId + ".jsonl"), "utf-8").includes("私密内容"));
  await sleep(1200);
  check("no inject to non-member alice", injects.length === 0, injects);
  out = await call(TOK.ze, "room_read", { room: privId });
  check("member reads private", text(out).includes("私密内容"));

  console.log("— room_invite —");
  out = await call(TOK.bb, "room_invite", { room: privId, name: "蓝莓" });
  check("outsider can't invite self", isErr(out), out);
  out = await call(TOK.bob, "room_invite", { room: privId, name: "蓝莓" });
  check("member invites", /added/.test(text(out)), out);
  out = await call(TOK.bb, "room_read", { room: privId });
  check("new member reads", text(out).includes("私密内容"), out);

  console.log("— public room —");
  out = await call(TOK.bob, "room_create", { name: "读书角", invite: ["alice"] });
  const pubId = (text(out).match(/id: (r[0-9a-f]{8})/) || [])[1];
  check("created public", !!pubId, text(out));
  out = await call(TOK.bb, "room_list", {});
  check("non-member sees public room", text(out).includes("读书角"), text(out));
  out = await call(TOK.bb, "room_post", { room: pubId, text: "旁听插话" });
  check("non-member post denied", isErr(out) && /not a member/.test(text(out)), out);
  injects.length = 0;
  await call(TOK.bob, "room_post", { room: pubId, text: "小屋消息" });
  await sleep(1200);
  check("inject to member alice with room label", injects.length === 1 && injects[0].text.includes("读书角") && injects[0].text.includes("小屋消息"), injects);
  out = await call(TOK.bb, "room_read", { room: pubId });
  check("non-member can read public", text(out).includes("小屋消息"), out);

  console.log("— room_read after (B2) —");
  await call(TOK.bob, "room_post", { text: "增量前" });
  await sleep(60);
  const cutTs = new Date().toISOString();
  await sleep(60);
  await call(TOK.bob, "room_post", { text: "增量后" });
  out = await call(TOK.ze, "room_read", { after: cutTs });
  check("after returns only newer", text(out).includes("增量后") && !text(out).includes("增量前"), text(out));
  out = await call(TOK.ze, "room_read", { after: "not-a-date" });
  check("bad after rejected", isErr(out), out);
  out = await call(TOK.ze, "room_read", { after: new Date().toISOString() });
  check("nothing newer -> no new messages", /no new messages/.test(text(out)), out);

  console.log("— json output & wait-after gap recovery —");
  out = await call(TOK.ze, "room_read", { limit: 3, json: true });
  var parsed = JSON.parse(text(out));
  check("read json shape", parsed.room === "lobby" && Array.isArray(parsed.messages)
    && parsed.messages.every(m => m.ts && m.who && typeof m.text === "string"), parsed);
  check("read json ISO ts", !Number.isNaN(Date.parse(parsed.messages[0].ts)), parsed.messages[0]);
  out = await call(TOK.ze, "room_read", { limit: 3, json: true, after: "2020-01-01T00:00:00Z" });
  parsed = JSON.parse(text(out));
  check("read json+after no recap field", parsed.recap === undefined && parsed.messages.length > 0, parsed);
  const t0 = Date.now();
  out = await call(TOK.ze, "room_wait", { timeout_s: 30, after: "2020-01-01T00:00:00Z", json: true });
  parsed = JSON.parse(text(out));
  check("wait-after returns missed immediately", Date.now() - t0 < 3000 && parsed.messages.length > 0,
    { ms: Date.now() - t0, n: parsed.messages.length });
  check("wait-after excludes own", parsed.messages.every(m => m.who !== "Zephyr"),
    parsed.messages.map(m => m.who));
  out = await call(TOK.ze, "room_wait", { timeout_s: 1, after: new Date().toISOString(), json: true });
  parsed = JSON.parse(text(out));
  check("wait json timeout marker", parsed.timeout === true && parsed.messages.length === 0, parsed);

  console.log("— mentions in json —");
  await call(TOK.bob, "room_post", { text: "@Zephyr @alice 你俩看这个" });
  out = await call(TOK.bb, "room_read", { limit: 3, json: true });
  parsed = JSON.parse(text(out));
  var lastM = parsed.messages[parsed.messages.length - 1];
  check("mentions parsed", Array.isArray(lastM.mentions)
    && lastM.mentions.includes("Zephyr") && lastM.mentions.includes("alice"), lastM);
  check("no-mention msgs omit field", parsed.messages.some(m => m.mentions === undefined), parsed.messages);

  console.log("— create validation —");
  out = await call(TOK.bob, "room_create", { name: "带路人", invite: ["不存在的人"] });
  check("unknown invitee rejected", isErr(out) && /unknown/.test(text(out)), out);
  out = await call(TOK.bob, "room_read", { room: "../../etc/passwd" });
  check("path traversal rejected", isErr(out), out);

  console.log("— web api —");
  async function web(pathq, token, opts) {
    const r = await fetch(base + pathq, Object.assign({ headers: { authorization: "Bearer " + token,
      "content-type": "application/json" } }, opts));
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  let w = await web("/room/api/rooms", TOK.bb);
  check("rooms list hides private? (蓝莓 now member so shows)", w.body.rooms.some(r => r.name === "悄悄话"), w.body);
  w = await web("/room/api/rooms", "BAD");
  check("web 401 bad token", w.status === 401);
  w = await web("/room/api/messages?room=" + pubId, TOK.bb);
  check("web read public room", w.status === 200 && w.body.canPost === false && w.body.messages.some(m => m.text === "小屋消息"), w.body);
  w = await web("/room/api/post", TOK.bb, { method: "POST", body: JSON.stringify({ room: pubId, text: "x" }) });
  check("web post denied non-member", w.status === 400, w);
  w = await web("/room/api/create", TOK.bob, { method: "POST", body: JSON.stringify({ name: "网页房", private: true, invite: ["蓝莓"] }) });
  check("web create", w.status === 200 && /网页房/.test(w.body.text), w);
  w = await web("/room/api/rooms", TOK.ze);
  check("hidden_private counted for outsider", w.body.hidden_private >= 1, w.body);
  check("participants roster", w.body.participants.length === 4 && w.body.participants.some(p => p.name === "蓝莓" && p.human), w.body.participants);
  check("room card has last_ts", w.body.rooms.some(r => r.id === "lobby" && r.last_ts), w.body.rooms);
  const ui = await fetch(base + "/room");
  const uiBody = await ui.text();
  check("no bundled ui: /room explains itself", ui.status === 500 && uiBody.includes("room ui missing"), uiBody);

  console.log("— avatars —");
  const jpeg1px = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";
  w = await web("/room/api/avatar", TOK.bob, { method: "POST", body: JSON.stringify({ name: "alice", data: jpeg1px }) });
  check("human sets AI avatar", w.status === 200 && w.body.avatar, w);
  w = await web("/room/api/avatar", TOK.ze, { method: "POST", body: JSON.stringify({ name: "bob", data: jpeg1px }) });
  check("AI can't set others' avatar", w.status === 403, w);
  w = await web("/room/api/avatar", TOK.ze, { method: "POST", body: JSON.stringify({ name: "Zephyr", data: jpeg1px }) });
  check("AI sets own avatar", w.status === 200, w);
  w = await web("/room/api/avatar", TOK.bob, { method: "POST", body: JSON.stringify({ name: "alice", data: "data:image/png;base64,AAAA" }) });
  check("non-jpeg rejected", w.status === 400, w);
  const av = await fetch(base + "/room/avatar/" + encodeURIComponent("alice"));
  check("avatar served", av.status === 200 && av.headers.get("content-type").includes("jpeg"));
  w = await web("/room/api/rooms", TOK.bob);
  check("participants carry avatar url", w.body.participants.some(p => p.name === "alice" && p.avatar), w.body.participants);

  srv.close(); sink.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
