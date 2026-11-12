// Relays score requests to the Worker, so the page's CORS rules never apply
// and the shared token never touches the search page. In fast mode it also fetches
// result pages directly, for the content script to extract their text.

importScripts("i18n.js");

const DEFAULTS = {
  workerUrl: "http://localhost:8787",
  token: "dev-token",
  jobProfile: "",
  monitorProfile: "",
  monitorInclude: "",
  monitorExclude: "",
};
/** One headline per line in the options page. */
const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const SHOPEE_FETCH_ERROR = "Shopee pages are read only while you browse";
function isShopeeUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "shopee.tw" || host.endsWith(".shopee.tw");
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "score") return;
  (async () => {
    // Filter here too: an older deployed Worker must not fetch Shopee on behalf
    // of the updated extension when it appears in search results.
    const excluded = msg.urls.filter(isShopeeUrl).map((url) => ({ url, error: SHOPEE_FETCH_ERROR }));
    const urls = msg.urls.filter((url) => !isShopeeUrl(url));
    if (!urls.length) {
      sendResponse({ results: excluded });
      return;
    }
    const { workerUrl, token, jobProfile, monitorProfile, monitorInclude, monitorExclude } =
      await chrome.storage.sync.get(DEFAULTS);
    try {
      const res = await fetch(`${workerUrl.replace(/\/$/, "")}/score`, {
        // The Worker bounds each page fetch; this only guards against a stuck connection.
        signal: AbortSignal.timeout(60_000),
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: msg.query,
          urls,
          pages: msg.pages,
          news: msg.news === true,
          // Each profile only goes along in its own mode: the job profile for job sites,
          // the monitoring client for search pages in monitoring mode.
          ...(msg.mode === "job" ? { mode: "job", profile: jobProfile } : {}),
          ...(msg.mode === "monitor"
            ? {
                mode: "monitor",
                profile: monitorProfile,
                examples: { include: lines(monitorInclude), exclude: lines(monitorExclude) },
              }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`Worker ${res.status}: ${await res.text()}`);
      const result = await res.json();
      sendResponse({ ...result, results: [...result.results, ...excluded] });
    } catch (err) {
      sendResponse({ error: err?.name === "TimeoutError" ? L("timeout") : String(err) });
    }
  })();
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Shopee capture: rows from pages the person browsed go to the local product monitor
// (~/product-monitor/receiver.py), which merges them into the daily price report.

const CAPTURE_URL = "http://localhost:8788/shopee";

/** Keeps only the expected fields of a content-script status, with bounded text. */
function shopeeStatus(msg, total) {
  const text = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const row = (r) => ({ name: text(r?.name), price: num(r?.price), price_max: num(r?.price_max),
    sold: num(r?.sold), variant: text(r?.variant) });
  const p = msg.product;
  return {
    total, error: !!msg.error, at: Date.now(),
    recent: Array.isArray(msg.recent) ? msg.recent.slice(-8).map(row) : [],
    product: p && typeof p === "object" ? {
      ...row(p), saved: !!p.saved,
      options: Array.isArray(p.options) ? p.options.slice(0, 5).map(text).filter(Boolean) : [],
      variant: p.variant && typeof p.variant === "object" ? { name: text(p.variant.name), price: num(p.variant.price) } : null,
    } : null,
  };
}

// A full page load starts a new visit (a Shopee page reports again once it has read
// something); closing the tab ends it.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") chrome.storage.session.remove(`shopee:${tabId}`);
});
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(`shopee:${tabId}`); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "shopeeCapture" && msg?.type !== "shopeeStatus") return;
  if (new URL(sender.url ?? "https://invalid.local").origin !== "https://shopee.tw" || sender.tab?.id == null) return;
  if (msg.type === "shopeeStatus") {
    const total = Number.isSafeInteger(msg.total) && msg.total >= 0 ? msg.total : 0;
    const tabId = sender.tab.id;
    // On a product page with an option selected the badge shows that option's state
    // (✓ saved, … not yet), since selecting an option does not change the item count.
    const option = msg.product?.variant || msg.product?.options?.length ? (msg.product.saved ? "✓" : "…") : null;
    Promise.all([
      chrome.action.setBadgeText({ tabId, text: msg.error ? "!" : option ?? (total > 999 ? "999+" : String(total)) }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: msg.error ? "#a33a22" : option === "…" ? "#a35a00" : "#1f6f43" }),
      chrome.action.setTitle({ tabId, title: msg.error ? "LinkScout：本機商品接收器無法連線，尚未儲存" : `LinkScout：此頁瀏覽期間已記錄 ${total} 件商品（僅畫面文字）。點這裡看記到什麼` }),
      // For the toolbar popup (popup.js), which shows what this tab recorded.
      chrome.storage.session.set({ [`shopee:${tabId}`]: shopeeStatus(msg, total) }),
    ]).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  fetch(CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: msg.page, items: msg.items }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => sendResponse(res.ok ? { ok: true } : { error: `HTTP ${res.status}` }))
    .catch((err) => sendResponse({ error: String(err) }));
  return true;
});

// ---------------------------------------------------------------------------
// PTT capture: the result list of a board search page the person opened goes to the
// same local product monitor (ptt.js), to count how much a brand is discussed.

const PTT_CAPTURE_URL = "http://localhost:8788/ptt";

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "pttCapture") return;
  if (new URL(sender.url ?? "https://invalid.local").origin !== "https://www.ptt.cc" || sender.tab?.id == null) return;
  const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const posts = (Array.isArray(msg.posts) ? msg.posts : []).slice(0, 100).map((p) => ({
    title: text(p?.title, 200), url: text(p?.url, 300), date: text(p?.date, 10),
    pushes: Number.isInteger(p?.pushes) ? p.pushes : null, author: text(p?.author, 40),
  }));
  const tabId = sender.tab.id;
  fetch(PTT_CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: text(msg.page, 500), board: text(msg.board, 40), query: text(msg.query, 100),
      page_no: Number.isInteger(msg.page_no) ? msg.page_no : null, items: posts }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      chrome.action.setBadgeText({ tabId, text: res.ok ? String(posts.length) : "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: res.ok ? "#1f6f43" : "#a33a22" });
      chrome.action.setTitle({ tabId, title: res.ok ? `LinkScout：已記錄這頁 ${posts.length} 篇 PTT 搜尋結果` : "LinkScout：本機接收器無法連線，尚未儲存" });
    })
    .catch(() => {
      chrome.action.setBadgeText({ tabId, text: "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33a22" });
    });
});

// ---------------------------------------------------------------------------
// Dcard capture: posts on a post search page or a forum page the person scrolled through
// (dcard.js). Search results feed the product monitor; forum pages go to their own file.

const DCARD_CAPTURE_URL = "http://localhost:8788/dcard";
const DCARD_FORUM_URL = "http://localhost:8788/dcard-forum";

// Per-tab badge counts live in chrome.storage.session, not in variables: Chrome stops
// this service worker after ~30 s idle, which would reset an in-memory count while the
// person is still reading the page. Updates to one key run one after another, so two
// saves finishing together don't overwrite each other. (The queue itself may be lost
// with the worker; only updates in flight at that moment need it.)
const tabCountQueue = new Map();

/** Adds to the tab's saved count under `key` and resolves to the new count.
 *  `add` is a number, or ids to count once each (posts re-sent with new scores). */
function addTabCount(key, add) {
  const run = async () => {
    const old = (await chrome.storage.session.get(key))[key];
    let value, n;
    if (Array.isArray(add)) {
      value = [...new Set([...(Array.isArray(old) ? old : []), ...add])];
      n = value.length;
    } else {
      value = n = (Number.isInteger(old) ? old : 0) + add;
    }
    await chrome.storage.session.set({ [key]: value });
    return n;
  };
  const next = (tabCountQueue.get(key) ?? Promise.resolve()).then(run, run);
  tabCountQueue.set(key, next.catch(() => {}));
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`dcard:${tabId}`, `reddit:${tabId}`]);
  tabCountQueue.delete(`dcard:${tabId}`);
  tabCountQueue.delete(`reddit:${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "dcardCapture") return;
  if (new URL(sender.url ?? "https://invalid.local").origin !== "https://www.dcard.tw" || sender.tab?.id == null) return;
  const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const int = (v) => (Number.isInteger(v) ? v : null);
  const posts = (Array.isArray(msg.posts) ? msg.posts : []).slice(0, 200).map((p) => ({
    id: text(p?.id, 20), forum: text(p?.forum, 40), title: text(p?.title, 200), url: text(p?.url, 300),
    created: text(p?.created, 40), likes: int(p?.likes), comments: int(p?.comments),
  }));
  const tabId = sender.tab.id;
  const listing = text(msg.listing, 100);
  fetch(listing ? DCARD_FORUM_URL : DCARD_CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listing ? { page: text(msg.page, 500), listing, items: posts }
      : { page: text(msg.page, 500), query: text(msg.query, 100), sort: text(msg.sort, 20), items: posts }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (res) => {
      const n = res.ok ? await addTabCount(`dcard:${tabId}`, posts.length) : 0;
      chrome.action.setBadgeText({ tabId, text: res.ok ? String(n) : "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: res.ok ? "#1f6f43" : "#a33a22" });
      chrome.action.setTitle({ tabId, title: res.ok ? `LinkScout：已記錄這頁 ${n} 篇 Dcard 文章` : "LinkScout：本機接收器無法連線，尚未儲存" });
      sendResponse(res.ok ? { ok: true } : { error: `HTTP ${res.status}` });
    })
    .catch((err) => {
      chrome.action.setBadgeText({ tabId, text: "!" });
      sendResponse({ error: String(err) });
    });
  return true;
});

// ---------------------------------------------------------------------------
// Fast mode: fetch a result page from the user's browser. News sites answer in well
// under a second, against 3–30 s through Browser Run or Jina. Needs the optional
// <all_urls> host permission, granted from the options page; without it, the Worker
// fetches pages as before.
// ---------------------------------------------------------------------------

const ALL_SITES = { origins: ["<all_urls>"] };
const PAGE_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 5_000_000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "fastMode") {
    chrome.permissions.contains(ALL_SITES).then(sendResponse);
    return true;
  }
  if (msg?.type !== "fetchHtml") return;
  fetchHtml(msg.url).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

async function fetchHtml(url) {
  if (isShopeeUrl(url)) return { error: SHOPEE_FETCH_ERROR };
  if (!(await chrome.permissions.contains(ALL_SITES))) return { error: "fast mode off" };
  // No cookies: the page as a logged-out visitor sees it, like Browser Run would.
  const res = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const type = res.headers.get("content-type") ?? "";
  if (!/html/i.test(type)) return { error: `not HTML (${type})` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_HTML_BYTES) return { error: "page too large" };
  return { html: decode(bytes, type), url: res.url };
}

/** Decode with the page's declared charset (some Taiwanese sites still serve Big5), else UTF-8. */
function decode(bytes, contentType) {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset =
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Reddit capture: posts on Reddit pages the person scrolled through (reddit.js), for
// the hn-daily Reddit list. Re-sent when a post's score or comment count changes.

const REDDIT_CAPTURE_URL = "http://localhost:8788/reddit";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "redditCapture") return;
  const origin = new URL(sender.url ?? "https://invalid.local").origin;
  if (!["https://www.reddit.com", "https://old.reddit.com"].includes(origin) || sender.tab?.id == null) return;
  const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const int = (v) => (Number.isInteger(v) ? v : null);
  const posts = (Array.isArray(msg.posts) ? msg.posts : []).slice(0, 200).map((p) => ({
    id: text(p?.id, 20), subreddit: text(p?.subreddit, 60), title: text(p?.title, 300), url: text(p?.url, 300),
    link: text(p?.link, 500), author: text(p?.author, 40), created: text(p?.created, 40),
    score: int(p?.score), comments: int(p?.comments),
  }));
  const tabId = sender.tab.id;
  fetch(REDDIT_CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: text(msg.page, 500), listing: text(msg.listing, 100), items: posts }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (res) => {
      const n = res.ok ? await addTabCount(`reddit:${tabId}`, posts.map((p) => p.id)) : 0;
      chrome.action.setBadgeText({ tabId, text: res.ok ? String(n) : "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: res.ok ? "#1f6f43" : "#a33a22" });
      chrome.action.setTitle({ tabId, title: res.ok ? `LinkScout：已記錄這個分頁 ${n} 篇 Reddit 貼文` : "LinkScout：本機接收器無法連線，尚未儲存" });
      sendResponse(res.ok ? { ok: true } : { error: `HTTP ${res.status}` });
    })
    .catch((err) => {
      chrome.action.setBadgeText({ tabId, text: "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33a22" });
      sendResponse({ error: String(err) });
    });
  return true;
});

// Comments loaded on a Reddit post page (reddit.js). Saved quietly: the badge keeps
// counting posts, and only turns to "!" when the receiver can't be reached.
const REDDIT_COMMENTS_URL = "http://localhost:8788/reddit-comments";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "redditComments") return;
  const origin = new URL(sender.url ?? "https://invalid.local").origin;
  if (!["https://www.reddit.com", "https://old.reddit.com"].includes(origin) || sender.tab?.id == null) return;
  const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const int = (v) => (Number.isInteger(v) ? v : null);
  const comments = (Array.isArray(msg.comments) ? msg.comments : []).slice(0, 500).map((c) => ({
    id: text(c?.id, 20), post: text(c?.post, 20), parent: text(c?.parent, 20), depth: int(c?.depth),
    author: text(c?.author, 40), score: int(c?.score), created: text(c?.created, 40),
    url: text(c?.url, 300), text: text(c?.text, 2000),
  }));
  const tabId = sender.tab.id;
  fetch(REDDIT_COMMENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: text(msg.page, 500), items: comments }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) {
        chrome.action.setBadgeText({ tabId, text: "!" });
        chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33a22" });
      }
      sendResponse(res.ok ? { ok: true } : { error: `HTTP ${res.status}` });
    })
    .catch((err) => {
      chrome.action.setBadgeText({ tabId, text: "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33a22" });
      sendResponse({ error: String(err) });
    });
  return true;
});

// ---------------------------------------------------------------------------
// Inbox: right-click "LinkScout：存到收集箱" saves the page (or the link under the
// cursor) and the selected text through the local receiver, which appends it to
// ~/hn-daily/收集箱.md. One item per click, only what the person picked; works on any
// site, including ones LinkScout never reads by itself (Facebook).

const INBOX_URL = "http://localhost:8788/inbox";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "inbox", title: "LinkScout：存到收集箱", contexts: ["page", "selection", "link"] });
  });
});

/** The item saved for a right-click: the link if one was clicked, else the page. */
function inboxItem(info, tab) {
  const text = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  return {
    url: text(info.linkUrl, 1000) ?? text(info.pageUrl, 1000), page: text(info.pageUrl, 1000),
    page_title: text(tab?.title, 300), text: text(info.selectionText, 3000),
  };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "inbox") return;
  const item = inboxItem(info, tab);
  const tabId = tab?.id;
  let ok = false;
  try {
    const res = await fetch(INBOX_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: item.page, items: [item] }), signal: AbortSignal.timeout(10_000),
    });
    ok = res.ok;
  } catch {}
  if (tabId == null) return;
  const old = await chrome.action.getBadgeText({ tabId }).catch(() => "");
  chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "!" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? "#1f6f43" : "#a33a22" });
  chrome.action.setTitle({ tabId, title: ok ? "LinkScout：已存到收集箱" : "LinkScout：本機接收器無法連線，沒有存到收集箱" });
  if (ok) setTimeout(() => chrome.action.setBadgeText({ tabId, text: old }).catch(() => {}), 3000);
});
