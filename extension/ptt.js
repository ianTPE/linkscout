// PTT board search pages (https://www.ptt.cc/bbs/<board>/search?q=...): records the
// result list the person opened (title, date, push count, author) for the local
// product monitor, which counts how much a brand is discussed each week.
// Reads the rendered list only; never fetches other pages or follows links.

/** Push count shown in the nrec column: number, 爆 (100+), X1..XX (negative), or blank. */
function pttPushes(text) {
  const t = (text ?? "").trim();
  if (!t) return 0;
  if (t === "爆") return 100;
  if (t === "XX") return -100;
  const x = t.match(/^X(\d)$/);
  if (x) return -10 * Number(x[1]);
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

/** Board and query from a search page URL, or null for other pages. */
function pttSearch(href) {
  try {
    const url = new URL(href);
    const m = url.pathname.match(/^\/bbs\/([\w-]+)\/search$/);
    const q = url.searchParams.get("q");
    return url.origin === "https://www.ptt.cc" && m && q ? { board: m[1], query: q, page_no: Number(url.searchParams.get("page") || 1) } : null;
  } catch {
    return null;
  }
}

/** One result row: { title, url, date: "M/DD", pushes, author }; null for deleted posts (no link). */
function pttRow(row, base) {
  const link = row.querySelector(".title a");
  if (!link) return null;
  const text = (sel) => row.querySelector(sel)?.textContent.trim() ?? "";
  return {
    title: link.textContent.trim(),
    url: new URL(link.getAttribute("href"), base).href,
    date: text(".meta .date"),
    pushes: pttPushes(text(".nrec")),
    author: text(".meta .author"),
  };
}

if (typeof module !== "undefined") {
  module.exports = { pttPushes, pttSearch, pttRow };
} else {
  (() => {
    const search = pttSearch(location.href);
    if (!search) return;
    const posts = [...document.querySelectorAll(".r-ent")].map((r) => pttRow(r, location.href)).filter(Boolean);
    // An empty result page is recorded too: "no posts" is an answer worth keeping.
    try {
      chrome.runtime.sendMessage({ type: "pttCapture", page: location.href, ...search, posts }).catch(() => {});
    } catch {
      // Extension reloaded while this page was open; a page refresh records it.
    }
  })();
}
