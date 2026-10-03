// Relays score requests to the Worker, so the page's CORS rules never apply
// and the shared token never touches the search page.

const DEFAULTS = { workerUrl: "http://localhost:8787", token: "dev-token" };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "score") return;
  (async () => {
    const { workerUrl, token } = await chrome.storage.sync.get(DEFAULTS);
    try {
      const res = await fetch(`${workerUrl.replace(/\/$/, "")}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: msg.query, urls: msg.urls, pages: msg.pages }),
      });
      if (!res.ok) throw new Error(`Worker ${res.status}: ${await res.text()}`);
      sendResponse(await res.json());
    } catch (err) {
      sendResponse({ error: String(err) });
    }
  })();
  return true; // keep the channel open for the async response
});
