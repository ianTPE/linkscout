const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const root = join(__dirname, "..");
const source = readFileSync(join(root, "shopee.js"), "utf8");

// Small rendered-DOM fixtures, not a substitute for a real Shopee browser test.
function element(text, options = {}) {
  return Object.freeze({
    innerText: text,
    href: options.href,
    parentElement: options.parent ?? null,
    querySelector: () => options.heading ?? null,
    getBoundingClientRect: () => ({ width: 200, height: 150, top: options.top ?? 20,
      bottom: (options.top ?? 20) + 150, left: 20, right: 220 }),
    checkVisibility: () => !options.hidden,
  });
}

function card(text = "測試商品\n$1,299\n已售出 10", options = {}) {
  return element(text, { href: "https://shopee.tw/測試商品-i.123.456", heading: element("測試商品"), ...options });
}

function harness({ cards = [card()], heading = null, href = "https://shopee.tw/search?keyword=test", fail = false } = {}) {
  const messages = [];
  const timers = [];
  const listeners = {};
  let observer;
  let now = 100_000;
  const network = () => { throw new Error("Page network must not be used"); };
  const document = {
    visibilityState: "visible", documentElement: Object.freeze({}), body: Object.freeze({}),
    querySelectorAll: () => cards,
    querySelector: () => heading,
    addEventListener: (event, callback) => { listeners[event] = callback; },
    createElement: () => { throw new Error("No page UI may be created"); },
  };
  const window = Object.freeze({
    fetch: network,
    addEventListener: (event, callback) => { listeners[event] = callback; },
    postMessage: () => { throw new Error("No page messages may be emitted"); },
  });
  const xhr = Object.freeze({ prototype: Object.freeze({ open: network }) });
  vm.runInNewContext(source, {
    document, window, XMLHttpRequest: xhr, fetch: network,
    URL, location: { href }, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    setTimeout: (callback, delay) => { assert.equal(delay, 1200); timers.push(callback); return timers.length; },
    Date: { now: () => now },
    chrome: { runtime: { sendMessage: async (msg) => {
      messages.push(JSON.parse(JSON.stringify(msg)));
      return msg.type === "shopeeCapture" && fail ? { error: "offline" } : { ok: true };
    } } },
  });
  return {
    messages, timers, listeners, document,
    mutate: () => observer(),
    tick: async () => { const callback = timers.shift(); if (callback) await callback(); },
    advance: (ms) => { now += ms; },
    captures: () => messages.filter((msg) => msg.type === "shopeeCapture"),
  };
}

test("manifest removes the main-world hook and starts after the DOM is ready", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.filter((script) => script.matches.includes("https://shopee.tw/*"));
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].world ?? "ISOLATED", "ISOLATED");
  assert.equal(scripts[0].run_at, "document_idle");
  assert.deepEqual(scripts[0].js, ["shopee.js"]);
  assert.equal(existsSync(join(root, "shopee-hook.js")), false);
});

test("captures rendered rows without page mutation, window messages, or network use", async () => {
  const h = harness();
  await h.tick();
  assert.equal(h.captures().length, 1);
  assert.deepEqual(h.captures()[0].items[0], {
    shopid: "123", itemid: "456", url: "https://shopee.tw/product/123/456", name: "測試商品",
    price: 1299, price_max: null, shop_name: null, sold: null, stock: null, location: null, official: null,
  });
  assert.equal(h.messages[1].type, "shopeeStatus");
  assert.equal(h.messages[1].total, 1);
  assert.equal(h.listeners.message, undefined);
});

test("supports price ranges and canonical product URLs", async () => {
  const h = harness({ cards: [card("商品\nNT$ 1,000 ～ $1,500", { href: "https://shopee.tw/product/123/456?extra=1" })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 1000);
  assert.equal(h.captures()[0].items[0].price_max, 1500);
});

test("skips ambiguous sale prices, coupons, malformed prices and inverted ranges", async () => {
  for (const text of ["$200\n$100", "折價券 $100", "$12,34", "$200-$100", "售出 123", "$​100"]) {
    const h = harness({ cards: [card(text)] });
    await h.tick();
    assert.equal(h.captures().length, 0, text);
  }
});

test("skips hidden, offscreen, headingless and cross-origin cards", async () => {
  const h = harness({ cards: [card(undefined, { hidden: true }), card(undefined, { top: 900 }),
    card(undefined, { heading: null }), card(undefined, { href: "https://evil.example/product/123/456" })] });
  await h.tick();
  assert.equal(h.captures().length, 0);
});

test("captures a product heading with an unambiguous sibling price", async () => {
  const section = element("商品標題\n$888");
  const heading = element("商品標題", { parent: section });
  const h = harness({ cards: [], heading, href: "https://shopee.tw/product/123/456" });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 888);
  assert.equal(h.captures()[0].items[0].name, "商品標題");
});

test("coalesces mutation bursts, skips hidden tabs and deduplicates saved rows", async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.mutate();
  assert.equal(h.timers.length, 1);
  h.document.visibilityState = "hidden";
  await h.tick();
  assert.equal(h.captures().length, 0);
  h.document.visibilityState = "visible";
  h.listeners.visibilitychange();
  await h.tick();
  h.listeners.scroll();
  await h.tick();
  assert.equal(h.captures().length, 1);
});

test("records changed prices without inflating the unique-item count", async () => {
  const cards = [card()];
  const h = harness({ cards });
  await h.tick();
  cards[0] = card("測試商品\n$999");
  h.mutate();
  await h.tick();
  assert.equal(h.captures().length, 2);
  assert.equal(h.captures()[1].items[0].price, 999);
  assert.equal(h.messages.at(-1).total, 1);
});

test("failed saves are retried after backoff and are not marked as saved", async () => {
  const h = harness({ fail: true });
  await h.tick();
  assert.equal(h.messages.at(-1).error, true);
  h.mutate();
  await h.tick();
  assert.equal(h.captures().length, 1);
  h.advance(30_000);
  h.listeners.scroll();
  await h.tick();
  assert.equal(h.captures().length, 2);
});

function background() {
  const listeners = [];
  const requests = [];
  const badges = [];
  const context = vm.createContext({
    importScripts() {}, URL, AbortSignal,
    chrome: {
      storage: { sync: { get: async (defaults) => defaults } },
      runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
      permissions: { contains: async () => true },
      action: Object.fromEntries(["setBadgeText", "setBadgeBackgroundColor", "setTitle"].map((key) =>
        [key, async (value) => { badges.push({ key, ...value }); }])),
    },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ results: [] }) }; },
  });
  vm.runInContext(readFileSync(join(root, "background.js"), "utf8"), context);
  return { context, listeners, requests, badges };
}

test("background saves only to the local receiver and uses browser toolbar status", async () => {
  const b = background();
  const sender = { url: "https://shopee.tw/search", tab: { id: 42 } };
  const handler = b.listeners[1];
  await new Promise((resolve) => handler({ type: "shopeeCapture", page: sender.url, items: [] }, sender, resolve));
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].url, "http://localhost:8788/shopee");
  await new Promise((resolve) => handler({ type: "shopeeStatus", total: 7 }, sender, resolve));
  assert.equal(b.requests.length, 1);
  assert.ok(b.badges.some((badge) => badge.tabId === 42 && badge.text === "7"));
  handler({ type: "shopeeCapture" }, { url: "https://example.com", tab: { id: 42 } }, () => {});
  assert.equal(b.requests.length, 1);
});

test("fast-mode fetcher blocks Shopee and subdomains before any request", async () => {
  const b = background();
  for (const url of ["https://shopee.tw/product/1/2", "https://www.shopee.tw/", "https://SHOPEE.tw/"]) {
    const result = await vm.runInContext(`fetchHtml(${JSON.stringify(url)})`, b.context);
    assert.match(result.error, /Shopee/);
  }
  assert.equal(b.requests.length, 0);
});

test("Shopee-only search scoring never reaches an older Worker", async () => {
  const b = background();
  const result = await new Promise((resolve) => b.listeners[0]({ type: "score", urls: ["https://shopee.tw/product/1/2"] }, {}, resolve));
  assert.equal(b.requests.length, 0);
  assert.match(result.results[0].error, /Shopee/);
});

test("mixed search scoring removes Shopee URLs from the Worker request", async () => {
  const b = background();
  const result = await new Promise((resolve) => b.listeners[0]({ type: "score", query: "商品", urls: ["https://shopee.tw/product/1/2", "https://example.com/"] }, {}, resolve));
  assert.equal(b.requests.length, 1);
  assert.deepEqual(JSON.parse(b.requests[0].options.body).urls, ["https://example.com/"]);
  assert.match(result.results[0].error, /Shopee/);
});
