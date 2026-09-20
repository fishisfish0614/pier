"use strict";

// store.js — a tiny JSON session store with two safety properties:
//
//   1. Atomic writes: every save goes to a temp file and is renamed into place,
//      so a crash mid-write can never truncate the live sessions file.
//   2. A global serial lock: a single Node process can still lose updates when
//      two async read-modify-write cycles interleave on the same file.
//      withSessions() chains every mutation so they run strictly one at a time.

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");

function createSessionStore(dataDir) {
  const file = path.join(dataDir, "guest-sessions.json");
  let ensured = false;

  async function ensureDir() {
    if (ensured) return;
    await mkdir(dataDir, { recursive: true });
    ensured = true;
  }

  async function load() {
    try {
      return JSON.parse(await readFile(file, "utf-8"));
    } catch (e) {
      // Missing or unreadable file => start from an empty set.
      return { sessions: [] };
    }
  }

  async function save(data) {
    await ensureDir();
    const tmp = file + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  }

  // The mutator receives the freshly-loaded data, mutates it in place (and may
  // return a value), and the result is saved atomically before the next mutator
  // in the chain runs.
  let lock = Promise.resolve();
  function withSessions(mutator) {
    const run = lock.then(async () => {
      const data = await load();
      const result = await mutator(data);
      await save(data);
      return result;
    });
    // Keep the chain alive even if one mutation rejects.
    lock = run.then(() => {}, () => {});
    return run;
  }

  return { file, load, save, withSessions };
}

module.exports = { createSessionStore };
