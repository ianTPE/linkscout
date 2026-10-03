// Finds result links on the SERP (including ones rendered later), sends new ones
// to the background in small batches, and pins a badge + key passage next to each.
//
// Per-site settings:
//   query()        the search terms
//   links          selector for result title links
//   canonical(u)   optional: strip tracking params so the same result caches once
//   content(url)   optional: fetch the result's text from inside this page, for sites
//                  that block Browser Run / Jina; returns { title, markdown } or null

const param = (name) => () => new URLSearchParams(location.search).get(name);

const ENGINES = {
  "www.google.com": { query: param("q"), links: "#search a:has(h3)" },
  "www.bing.com": { query: param("q"), links: "#b_results li.b_algo h2 a" },
  "duckduckgo.com": { query: param("q"), links: 'a[data-testid="result-title-a"]' },
  "www.104.com.tw": {
    query: param("keyword"),
    links: 'h2 a[href*="/job/"]',
    canonical: (u) => u.origin + u.pathname, // drop ?jobsource=…
    content: fetch104Job,
  },
};

/**
 * 104 job pages sit behind a Cloudflare challenge that Browser Run and Jina often fail.
 * Its own JSON API is same-origin here and already passes in the user's browser.
 */
async function fetch104Job(url) {
  const id = new URL(url).pathname.split("/").pop();
  const res = await fetch(`/job/ajax/content/${id}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const d = (await res.json())?.data;
  if (!d?.jobDetail) return null;

  const job = d.jobDetail;
  const cond = d.condition ?? {};
  const names = (xs) => (xs ?? []).map((x) => x.description).filter(Boolean).join("、");
  const lines = [
    `# ${d.header?.jobName ?? ""}`,
    "",
    `公司：${d.header?.custName ?? ""}`,
    `薪資：${job.salary ?? ""}`,
    `地點：${job.addressRegion ?? ""}${job.addressDetail ?? ""}`,
    `職務類別：${names(job.jobCategory)}`,
    job.remoteWork?.description ? `遠端：${job.remoteWork.description}` : null,
    "", "## 工作內容", "", job.jobDescription ?? "",
    "", "## 條件要求", "",
    `工作經歷：${cond.workExp ?? ""}`,
    `學歷：${cond.edu ?? ""}`,
    `擅長工具：${names(cond.specialty)}`,
    `工作技能：${names(cond.skill)}`,
    "", cond.other ?? "",
    "", "## 福利", "", d.welfare?.welfare ?? "",
  ];
  return {
    title: `${d.header?.jobName ?? ""}｜${d.header?.custName ?? ""}`,
    markdown: lines.filter((l) => l !== null).join("\n"),
  };
}

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
    return engine.canonical ? engine.canonical(u) : u.href;
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

async function flush() {
  timer = null;
  const batch = pending;
  pending = new Map();
  const query = engine.query();
  if (!query) return;

  const urls = [...batch.keys()];
  for (let i = 0; i < urls.length; i += 10) {
    const chunk = urls.slice(i, i + 10);
    const pages = engine.content ? await collectPages(chunk) : undefined;
    chrome.runtime.sendMessage({ type: "score", query, urls: chunk, pages }, (resp) => {
      for (const url of chunk) {
        const r = resp?.results?.find((x) => x.url === url);
        mount(batch.get(url), r ?? { error: resp?.error ?? "no response" });
      }
    });
  }
}

const boxes = new WeakMap(); // anchor -> its .linkscout box

/**
 * Where to insert the box. Google wraps result titles in a flipped span
 * (transform: scaleY(-1)) inside a column-reverse flexbox; anything inserted
 * inside renders upside down and above the title. Go past the outermost such wrapper.
 */
function mountPoint(anchor) {
  let point = anchor;
  for (let el = anchor, depth = 0; el && el !== document.body && depth < 6; el = el.parentElement, depth++) {
    const cs = getComputedStyle(el);
    if (cs.transform !== "none" || cs.flexDirection.endsWith("reverse")) point = el;
  }
  return point;
}

/** Pages this site lets us read directly; a failed one is left for the Worker to fetch. */
async function collectPages(urls) {
  const pages = {};
  await Promise.all(
    urls.map(async (url) => {
      try {
        const page = await engine.content(url);
        if (page) pages[url] = page;
      } catch {}
    }),
  );
  return pages;
}

function mount(anchor, data) {
  let box = boxes.get(anchor);
  if (!box) {
    box = document.createElement("div");
    box.className = "linkscout";
    mountPoint(anchor).insertAdjacentElement("afterend", box);
    boxes.set(anchor, box);
  }
  box.replaceChildren();
  box.removeAttribute("title");

  if (data.loading) {
    box.append(badge("…", "ls-loading"));
    return;
  }
  if (data.error) {
    box.append(badge("無法讀取", "ls-error"));
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
