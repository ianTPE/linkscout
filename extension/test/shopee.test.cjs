const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const root = join(__dirname, "..");
const source = readFileSync(join(root, "shopee.js"), "utf8");

// A tiny rendered-DOM fake, not a substitute for a real Shopee browser test.
// Supports only the selectors shopee.js uses.
function matches(el, selector) {
  return selector.split(",").some((part) => {
    const m = part.trim().match(/^(\*|\w+)?(?:\[([\w-]+)(\*?=)"([^"]*)"\])?$/);
    if (!m) throw new Error(`Unsupported selector: ${part}`);
    const [, tag, attr, op, value] = m;
    if (tag && tag !== "*" && tag !== el.tagName) return false;
    if (!attr) return true;
    const actual = el.attrs[attr];
    return actual !== undefined && (op === "=" ? actual === value : actual.includes(value));
  });
}

function node(tagName, attrs = {}, ...kids) {
  const el = {
    tagName, attrs, parentElement: null, children: [], childNodes: [],
    get href() { return attrs.href; },
    get textContent() { return el.childNodes.map((n) => n.textContent).join(""); },
    get innerText() { return el.textContent; },
    descendants() { return el.children.flatMap((c) => [c, ...c.descendants()]); },
    matches: (selector) => matches(el, selector),
    getAttribute: (name) => attrs[name] ?? null,
    querySelectorAll: (selector) => el.descendants().filter((d) => matches(d, selector)),
    querySelector: (selector) => el.querySelectorAll(selector)[0] ?? null,
    closest(selector) {
      for (let e = el; e; e = e.parentElement) if (matches(e, selector)) return e;
      return null;
    },
    contains(other) {
      for (let e = other; e; e = e.parentElement) if (e === el) return true;
      return false;
    },
    // display: contents has no box, like the real thing.
    getBoundingClientRect: () => attrs.display === "contents" ? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }
      : { width: 200, height: 150, top: attrs.top ?? 20, bottom: (attrs.top ?? 20) + 150, left: 20, right: 220 },
    checkVisibility: () => !attrs.hidden && attrs.display !== "contents",
  };
  for (const kid of kids) {
    if (typeof kid === "string") {
      el.childNodes.push({ nodeType: 3, textContent: kid });
    } else {
      kid.parentElement = el;
      el.children.push(kid);
      el.childNodes.push(kid);
    }
  }
  return el;
}

// Shaped like a Shopee search card: badge image before the title, "$" and the
// amount in separate spans, sales and location as extra text.
const price = (amount, attrs = {}) => node("div", attrs, node("span", {}, "$"), node("span", {}, amount));

function card({ name = "測試商品 10ml", prices = [price("1,299")], sold = "已售出 10", ...attrs } = {}) {
  return node("a", { href: "https://shopee.tw/測試商品-i.123.456", ...attrs },
    node("div", {}, node("img"), name),
    ...prices,
    node("div", {}, sold), node("span", {}, "高雄市"));
}

// Element-only TreeWalker over body's descendants in document order.
function treeWalker(root) {
  const nodes = root.descendants();
  return {
    currentNode: root,
    nextNode() {
      const next = nodes[nodes.indexOf(this.currentNode) + 1] ?? null;
      if (next) this.currentNode = next;
      return next;
    },
  };
}

function harness({ cards = [card()], heading = null, body = node("body"), href = "https://shopee.tw/search?keyword=test", fail = false } = {}) {
  const messages = [];
  const timers = [];
  const listeners = {};
  let observer;
  let now = 100_000;
  const network = () => { throw new Error("Page network must not be used"); };
  const document = {
    visibilityState: "visible", documentElement: Object.freeze({}), body,
    // Card links come from the cards list; other lookups (option buttons) search body.
    querySelectorAll: (selector) => selector.startsWith("a[") ? cards : body.querySelectorAll(selector),
    querySelector: () => heading,
    createTreeWalker: (root, whatToShow) => { assert.equal(whatToShow, 1); return treeWalker(root); },
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
    getComputedStyle: (el) => ({ visibility: "visible", display: el.attrs.display ?? "block",
      textDecorationLine: el.attrs.strike ? "line-through" : "none" }),
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
    shopid: "123", itemid: "456", url: "https://shopee.tw/product/123/456", name: "測試商品 10ml",
    price: 1299, price_max: null, shop_name: null, sold: 10, stock: null, location: null, official: null,
  });
  assert.equal(h.messages[1].type, "shopeeStatus");
  assert.equal(h.messages[1].total, 1);
  assert.equal(h.listeners.message, undefined);
});

test("reads Shopee's display: contents card links by their children", async () => {
  const h = harness({ cards: [card({ display: "contents" })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 1299);
});

test("prefers a visible heading for the name", async () => {
  const h = harness({ cards: [node("a", { href: "https://shopee.tw/x-i.123.456" },
    node("div", {}, "熱銷第一名的標籤"), node("h3", {}, "標題 10ml"), price("500"))] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].name, "標題 10ml");
});

test("supports price ranges and canonical product URLs", async () => {
  const range = node("div", {}, node("span", {}, "NT$ 1,000"), " ～ ", node("span", {}, "$1,500"));
  const h = harness({ cards: [card({ prices: [range], href: "https://shopee.tw/product/123/456?extra=1" })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 1000);
  assert.equal(h.captures()[0].items[0].price_max, 1500);
});

test("ignores aria-hidden duplicate prices", async () => {
  const h = harness({ cards: [card({ prices: [price("600"), node("div", { "aria-hidden": "true" }, price("600"), price("900"))] })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 600);
});

test("skips ambiguous sale prices, coupons, malformed prices and inverted ranges", async () => {
  const cases = {
    "sale plus old price": [price("200"), price("100")],
    coupon: [node("div", {}, "折價券 $100")],
    malformed: [price("12,34")],
    inverted: [node("div", {}, "$200-$100")],
    "no price": [],
    "zero-width space": [node("div", {}, "$​100")],
  };
  for (const [label, prices] of Object.entries(cases)) {
    const h = harness({ cards: [card({ prices })] });
    await h.tick();
    assert.equal(h.captures().length, 0, label);
  }
});

test("skips hidden, offscreen, nameless and cross-origin cards", async () => {
  const h = harness({ cards: [card({ hidden: true }), card({ top: 900 }), card({ name: "" }),
    card({ href: "https://evil.example/product/123/456" })] });
  await h.tick();
  assert.equal(h.captures().length, 0);
});

// Shaped like a Shopee product page: the price sits several levels away from the
// title, and later sections carry other amounts such as a "$30" coupon.
function productPage(...afterTitle) {
  const heading = node("h1", {}, "商品標題 15ml");
  const body = node("body", {},
    node("div", {}, node("div", {}, node("div", {}, heading)), node("div", {}, "5.0"), node("span", {}, "1,000+")),
    ...afterTitle,
    node("section", {}, node("h2", {}, "運送"), node("span", {}, "可領取"), price("30")),
    node("a", { href: "https://shopee.tw/other-i.1.2" }, node("div", {}, "推薦商品名稱"), price("50")));
  return { heading, body };
}

test("captures a product page's price that follows its title", async () => {
  const h = harness({ cards: [], ...productPage(node("section", {}, node("div", {}, node("div", {}, "$219 - $799")))),
    href: "https://shopee.tw/product/123/456" });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 219);
  assert.equal(h.captures()[0].items[0].price_max, 799);
  assert.equal(h.captures()[0].items[0].name, "商品標題 15ml");
});

test("skips a product page whose price before the next heading is ambiguous or missing", async () => {
  for (const afterTitle of [[price("200"), price("300")], []]) {
    const h = harness({ cards: [], ...productPage(...afterTitle), href: "https://shopee.tw/product/123/456" });
    await h.tick();
    assert.equal(h.captures().length, 0);
  }
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
  cards[0] = card({ prices: [price("999")] });
  h.mutate();
  await h.tick();
  assert.equal(h.captures().length, 2);
  assert.equal(h.captures()[1].items[0].price, 999);
  assert.equal(h.messages.at(-1).total, 1);
});

test("reads sales counts from cards and product pages", async () => {
  const h = harness({ cards: [card({ sold: "已售出 1.2萬+" })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].sold, 12000);
  const page = productPage(node("div", {}, node("span", {}, "1,000+"), "已售出"), price("590"));
  const p = harness({ cards: [], ...page, href: "https://shopee.tw/product/123/456" });
  await p.tick();
  assert.equal(p.captures()[0].items[0].sold, 1000);
});

test("ignores a struck-through old price next to the sale price", async () => {
  const h = harness({ cards: [card({ prices: [price("650", { strike: true }), price("590")] })] });
  await h.tick();
  assert.equal(h.captures()[0].items[0].price, 590);
});

function optionButton(label, selected) {
  return node("button", { class: `lK5dVS selection-box-${selected ? "selected" : "unselected"}`, "aria-label": label },
    node("span", {}, label));
}

test("records the option the person selected with its single price", async () => {
  const options = node("section", {}, node("h2", {}, "容量"), optionButton("10ml", true), optionButton("30ml", false));
  const page = productPage(price("590"));
  const body = node("body", {}, ...page.body.children, options);
  const h = harness({ cards: [], heading: page.heading, body, href: "https://shopee.tw/product/123/456" });
  await h.tick();
  assert.equal(h.captures().length, 0); // first read waits for a second one to agree
  assert.equal(h.messages.at(-1).product.saved, false);
  await h.tick();
  const rows = h.captures()[0].items;
  assert.equal(rows.length, 1);
  assert.deepEqual({ kind: rows[0].kind, partial: rows[0].partial, variants: rows[0].variants },
    { kind: "variants", partial: true, variants: [{ name: "10ml", price: 590, in_stock: null }] });
  const status = h.messages.at(-1);
  assert.equal(status.type, "shopeeStatus");
  assert.deepEqual(status.product.variant, { name: "10ml", price: 590, in_stock: null });
  assert.equal(status.product.saved, true);
});

test("does not pair a newly selected option with the previous option's price", async () => {
  const amount = node("span", {}, "1,141");
  const body = node("body", {}, node("h1", {}, "四胜肽賦活養髮液 公司貨"),
    node("div", {}, node("span", {}, "$"), amount),
    node("section", {}, node("h2", {}, "規格"), optionButton("90ml", true)));
  const h = harness({ cards: [], heading: body.children[0], body, href: "https://shopee.tw/product/123/456" });
  await h.tick(); // option already marked 90ml, price still the 45ml one
  amount.childNodes[0].textContent = "1,835";
  h.mutate();
  await h.tick();
  await h.tick();
  const saved = h.captures().flatMap((c) => c.items).map((r) => r.variants[0]);
  assert.deepEqual(saved, [{ name: "90ml", price: 1835, in_stock: null }]);
});

test("saves nothing from a product page while a selected option still shows a range", async () => {
  const page = productPage(node("div", {}, "$219 - $799"));
  const body = node("body", {}, ...page.body.children, node("section", {}, node("h2", {}, "顏色"), optionButton("紅", true)));
  const h = harness({ cards: [], heading: page.heading, body, href: "https://shopee.tw/product/123/456" });
  await h.tick();
  assert.equal(h.captures().length, 0);
  const status = h.messages.at(-1);
  assert.deepEqual(status.product.options, ["紅"]);
  assert.equal(status.product.variant, null);
  assert.equal(status.product.saved, false);
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
  const session = [];
  const context = vm.createContext({
    importScripts() {}, URL, AbortSignal,
    chrome: {
      storage: { sync: { get: async (defaults) => defaults },
        session: { set: async (value) => { session.push(value); }, remove: async () => {} } },
      runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
      permissions: { contains: async () => true },
      action: Object.fromEntries(["setBadgeText", "setBadgeBackgroundColor", "setTitle"].map((key) =>
        [key, async (value) => { badges.push({ key, ...value }); }])),
    },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ results: [] }) }; },
  });
  vm.runInContext(readFileSync(join(root, "background.js"), "utf8"), context);
  return { context, listeners, requests, badges, session };
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
  await new Promise((resolve) => handler({ type: "shopeeStatus", total: 1, product: { name: "x".repeat(500), price: 590,
    price_max: null, sold: 3, saved: true, options: ["10ml", 5], variant: { name: "10ml", price: 590 }, evil: "<b>" },
  recent: [{ name: "商品", price: "590" }] }, sender, resolve));
  const stored = b.session.at(-1)["shopee:42"];
  assert.ok(b.badges.some((badge) => badge.text === "✓"));
  await new Promise((resolve) => handler({ type: "shopeeStatus", total: 1, product: { options: ["10ml"], saved: false } }, sender, resolve));
  assert.equal(b.badges.filter((badge) => badge.key === "setBadgeText").at(-1).text, "…");
  assert.equal(stored.product.name.length, 200);
  assert.deepEqual(stored.product.options, ["10ml"]);
  assert.equal(stored.product.evil, undefined);
  assert.equal(stored.recent[0].price, null);
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
