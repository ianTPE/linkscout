const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const listener = () => ({ addListener() {} });

/** Starts background.js as a fresh service worker on top of `session` (a plain object),
 *  the way Chrome restarts a stopped worker with chrome.storage.session intact. */
function startWorker(session) {
  const chrome = {
    runtime: { onMessage: listener(), onInstalled: listener() },
    tabs: { onUpdated: listener(), onRemoved: listener() },
    action: {},
    permissions: {},
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      sync: { get: async () => ({}), set: async () => {} },
      onChanged: listener(),
      session: {
        get: async (key) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
        set: async (items) => { await new Promise((r) => setTimeout(r, 1)); Object.assign(session, structuredClone(items)); },
        remove: async () => {},
      },
    },
  };
  const ctx = vm.createContext({ chrome, URL, fetch: () => {}, AbortSignal, TextDecoder, setTimeout, console, structuredClone, navigator: { language: "en" } });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx));
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

test("tab counts survive a service worker restart", async () => {
  const session = {};
  assert.equal(await startWorker(session).addTabCount("dcard:1", 20), 20);
  assert.equal(await startWorker(session).addTabCount("dcard:1", 5), 25); // was 5 with an in-memory Map
});

test("saves finishing together don't overwrite each other", async () => {
  const session = {};
  const w = startWorker(session);
  assert.deepEqual(await Promise.all([w.addTabCount("dcard:2", 3), w.addTabCount("dcard:2", 4)]), [3, 7]);
  assert.equal(session["dcard:2"], 7);
});

test("Reddit posts re-sent with new scores are counted once", async () => {
  const session = {};
  const w = startWorker(session);
  assert.equal(await w.addTabCount("reddit:3", ["t3_a", "t3_b"]), 2);
  assert.equal(await startWorker(session).addTabCount("reddit:3", ["t3_b", "t3_c"]), 3);
});
