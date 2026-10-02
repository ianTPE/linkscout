// Finds result links on the SERP (including ones rendered later), sends new ones
// to the background in small batches, and pins a badge + key passage next to each.

const ENGINES = {
  "www.google.com": { query: () => new URLSearchParams(location.search).get("q"), links: "#search a:has(h3)" },
  "www.bing.com": { query: () => new URLSearchParams(location.search).get("q"), links: "#b_results li.b_algo h2 a" },
  "duckduckgo.com": { query: () => new URLSearchParams(location.search).get("q"), links: 'a[data-testid="result-title-a"]' },
};

const engine = ENGINES[location.hostname];
const seen = new Set();
let pending = new Map(); // url -> anchor
let timer = null;

const CATEGORY_LABEL = {
  docs: "文件", tutorial: "教學", qa: "問答", news: "新聞",
  research: "研究", blog: "部落格", product: "產品", other: "其他",
};

function realUrl(a) {
  try {
    const u = new URL(a.href);
    if (u.hostname.endsWith("google.com") && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url");
    return u.href;
  } catch {
    return null;
  }
}

function scan() {
  if (!engine) return;
  for (const a of document.querySelectorAll(engine.links)) {
    const url = realUrl(a);
    if (!url || !/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    pending.set(url, a);
    mount(a, { loading: true });
  }
  if (pending.size && !timer) timer = setTimeout(flush, 300);
}

function flush() {
  timer = null;
  const batch = pending;
  pending = new Map();
  const query = engine.query();
  if (!query) return;

  const urls = [...batch.keys()];
  for (let i = 0; i < urls.length; i += 10) {
    const chunk = urls.slice(i, i + 10);
    chrome.runtime.sendMessage({ type: "score", query, urls: chunk }, (resp) => {
      for (const url of chunk) {
        const r = resp?.results?.find((x) => x.url === url);
        mount(batch.get(url), r ?? { error: resp?.error ?? "no response" });
      }
    });
  }
}

function mount(anchor, data) {
  let box = anchor.parentElement.querySelector(":scope > .linkscout");
  if (!box) {
    box = document.createElement("div");
    box.className = "linkscout";
    anchor.insertAdjacentElement("afterend", box);
  }
  box.replaceChildren();

  if (data.loading) {
    box.append(badge("…", "ls-loading"));
    return;
  }
  if (data.error) {
    box.append(badge("?", "ls-error"));
    box.title = data.error;
    return;
  }

  const tier = data.score >= 70 ? "ls-high" : data.score >= 40 ? "ls-mid" : "ls-low";
  box.append(badge(String(data.score), tier), badge(CATEGORY_LABEL[data.category] ?? data.category, "ls-cat"));
  if (data.seoSpam > 0.6) box.append(badge("SEO", "ls-spam"));
  if (data.keyPassage) {
    const p = document.createElement("blockquote");
    p.className = "ls-passage";
    p.textContent = data.keyPassage;
    box.append(p);
  }
  box.title = `relevance ${data.relevance.toFixed(2)}/4 · depth ${data.depth.toFixed(2)}/3 · seo ${data.seoSpam.toFixed(2)} · via ${data.source}`;
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = `ls-badge ${cls}`;
  s.textContent = text;
  return s;
}

scan();
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
