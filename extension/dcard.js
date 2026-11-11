// Dcard post search pages (https://www.dcard.tw/search/posts?query=...): records the
// posts the person scrolled through (forum, title, time, likes, comments) for the local
// product monitor, which counts how much a brand is discussed each week.
// Reads the rendered list only; never fetches other pages or follows links.

/** Query and sort from a search page URL, or null for other pages. */
function dcardSearch(href) {
  try {
    const url = new URL(href);
    const q = url.searchParams.get("query");
    return url.origin === "https://www.dcard.tw" && /^\/search(\/posts)?\/?$/.test(url.pathname) && q
      ? { query: q, sort: url.searchParams.get("sort") || null } : null;
  } catch {
    return null;
  }
}

/** A count shown on a button: "6", "1,234", "1.2萬"; blank is 0; anything else is null. */
function dcardCount(text) {
  const t = (text ?? "").replace(/\s+/g, "");
  if (!t) return 0;
  const m = t.match(/^([\d,]+(?:\.\d+)?)(萬|k|K)?$/);
  if (!m) return null;
  const n = Number(m[1].replaceAll(",", "")) * (m[2] === "萬" ? 10_000 : m[2] ? 1_000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** One post card: { id, forum, title, url, created, likes, comments }; null if it is not a post. */
function dcardRow(article, base) {
  const link = article.querySelector('a[href*="/p/"]');
  const m = link?.getAttribute("href")?.match(/^\/f\/([\w-]+)\/p\/(\d+)/);
  if (!m) return null;
  const title = article.querySelector("h2")?.textContent.trim();
  if (!title) return null;
  // The first two buttons are ♡ likes and 💬 comments (then repost, share).
  const buttons = [...article.querySelectorAll("button")];
  return {
    id: m[2], forum: m[1], title,
    url: new URL(`/f/${m[1]}/p/${m[2]}`, base).href,
    created: article.querySelector("time")?.getAttribute("datetime") ?? null,
    likes: buttons[0] ? dcardCount(buttons[0].textContent) : null,
    comments: buttons[1] ? dcardCount(buttons[1].textContent) : null,
  };
}

if (typeof module !== "undefined") {
  module.exports = { dcardSearch, dcardCount, dcardRow };
} else {
  (() => {
    const sent = new Set(); // post ids already sent from this page
    let timer;
    let page = location.href;

    function stop() {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      clearTimeout(timer);
    }

    function scan() {
      timer = undefined;
      if (!globalThis.chrome?.runtime?.id) return stop(); // extension reloaded; a refresh starts the new script
      if (location.href !== page) { page = location.href; sent.clear(); } // new search in the same tab
      const search = dcardSearch(location.href);
      if (!search) return;
      const posts = [...document.querySelectorAll("article")]
        .map((a) => dcardRow(a, location.href)).filter((p) => p && !sent.has(p.id));
      if (!posts.length) return;
      try {
        chrome.runtime.sendMessage({ type: "dcardCapture", page: location.href, ...search, posts })
          .then((res) => { if (res?.ok) posts.forEach((p) => sent.add(p.id)); }, () => {});
      } catch {
        stop();
      }
    }

    function schedule() {
      if (timer === undefined) timer = setTimeout(scan, 1500);
    }

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, { passive: true });
    schedule();
  })();
}
