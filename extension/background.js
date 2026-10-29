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
