// Relays score requests to the Worker, so the page's CORS rules never apply
// and the shared token never touches the search page. In fast mode it also fetches
// result pages directly, for the content script to extract their text.

importScripts("i18n.js");

const DEFAULTS = { workerUrl: "http://localhost:8787", token: "dev-token", jobProfile: "", monitorProfile: "" };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "score") return;
  (async () => {
    const { workerUrl, token, jobProfile, monitorProfile } = await chrome.storage.sync.get(DEFAULTS);
    try {
      const res = await fetch(`${workerUrl.replace(/\/$/, "")}/score`, {
        // The Worker bounds each page fetch; this only guards against a stuck connection.
        signal: AbortSignal.timeout(60_000),
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: msg.query,
          urls: msg.urls,
          pages: msg.pages,
          news: msg.news === true,
          // Each profile only goes along in its own mode: the job profile for job sites,
          // the monitoring client for search pages in monitoring mode.
          ...(msg.mode === "job" ? { mode: "job", profile: jobProfile } : {}),
          ...(msg.mode === "monitor" ? { mode: "monitor", profile: monitorProfile } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Worker ${res.status}: ${await res.text()}`);
      sendResponse(await res.json());
    } catch (err) {
      sendResponse({ error: err?.name === "TimeoutError" ? L("timeout") : String(err) });
    }
  })();
  return true; // keep the channel open for the async response
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
