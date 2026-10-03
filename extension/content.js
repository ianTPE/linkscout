// Finds result links on the SERP (including ones rendered later), sends new ones
// to the background in small batches, and pins a badge + key passage next to each.
//
// Per-site settings:
//   query()        the search terms
//   links          selector for result title links (or a function returning one)
//   canonical(u)   optional: strip tracking params so the same result caches once
//   content(url)   optional: fetch the result's text from inside this page, for sites
//                  that block Browser Run / Jina; returns { title, markdown } or null
//   mode           optional: "job" scores results as job postings
//   reorder        optional: false (or a function returning false) where results must keep the site's order

const param = (name) => () => new URLSearchParams(location.search).get(name);

// Google's News tab (tbm=nws) titles are [role=heading] cards, not <h3>, laid out in a
// two-column grid grouped by story, which a flex-column reorder would collapse.
const isGoogleNews = () => param("tbm")() === "nws";
const GOOGLE = {
  query: param("q"),
  links: () => (isGoogleNews() ? '#search a:has([role="heading"])' : "#search a:has(h3)"),
  reorder: () => !isGoogleNews(),
};

const ENGINES = {
  "www.google.com": GOOGLE,
  "www.google.com.tw": GOOGLE,
  "www.bing.com": {
    query: param("q"),
    // News (/news/search) is a plain list of .news-card items with direct article links.
    links: () => (location.pathname.startsWith("/news/") ? "#algocore .news-card a.title" : "#b_results li.b_algo h2 a"),
  },
  "duckduckgo.com": { query: param("q"), links: 'a[data-testid="result-title-a"]' },
  "www.104.com.tw": {
    query: query104,
    links: 'h2 a[href*="/job/"]',
    canonical: (u) => u.origin + u.pathname, // drop ?jobsource=…
    content: fetch104Job,
    // 104's list is virtual: ~22 elements are recycled for whichever jobs are on screen,
    // so sorting them would shuffle jobs around while scrolling.
    reorder: false,
    mode: "job", // score as job postings against the profile from the options page
  },
};

/**
 * 104 rewrites the page title to describe every active filter, e.g.
 * "「軟體／工程類人員」台北市、新北市找可以在家上班的遠端工作職缺｜2026年10月－104人力銀行",
 * so area-only or category-only searches still have a query. Until the page sets it,
 * the title is the generic "最新找工作職缺－104人力銀行"; then fall back to ?keyword=.
 */
function query104() {
  const t = document.title
    .split(/[｜|]/)[0]
    .replace(/－104人力銀行$/, "")
    .replace("最新找工作", "找工作")
    .trim();
  return t && t !== "找工作職缺" ? t : param("keyword")();
}

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
  // { shifts: { 日班: ["11:30~15:00"], 晚班: [...] }, note } → "日班 11:30~15:00；晚班 …；note"
  const hours = (wp) =>
    [
      ...Object.entries(wp?.shifts ?? {}).map(([name, times]) => [name, ...(times ?? [])].join(" ")),
      wp?.note,
    ]
      .filter(Boolean)
      .join("；");
  // Facts go in tables: Jev still reads them, but they're not offered as the key passage
  // (the 104 result list already shows company, salary and location).
  const table = (rows) => {
    const filled = rows.filter(([, v]) => v);
    if (!filled.length) return [];
    const cell = (v) => String(v).replace(/\|/g, "／").replace(/\s*\n\s*/g, " ");
    return ["| 項目 | 內容 |", "| --- | --- |", ...filled.map(([k, v]) => `| ${k} | ${cell(v)} |`)];
  };
  const lines = [
    `# ${d.header?.jobName ?? ""}`,
    "",
    ...table([
      ["公司", d.header?.custName],
      ["薪資", job.salary],
      ["地點", `${job.addressRegion ?? ""}${job.addressDetail ?? ""}`],
      ["職務類別", names(job.jobCategory)],
      ["遠端", job.remoteWork?.description],
      ["上班時段", hours(job.workPeriod)],
      ["出差", job.businessTrip],
      ["管理責任", job.manageResp],
    ]),
    "", "## 工作內容", "", job.jobDescription ?? "",
    "", "## 條件要求", "",
    ...table([
      ["工作經歷", cond.workExp],
      ["學歷", cond.edu],
      ["擅長工具", names(cond.specialty)],
      ["工作技能", names(cond.skill)],
      ["接受身份", names(cond.acceptRole?.role)],
    ]),
    "", cond.other ?? "",
    "", "## 福利", "",
    ...table([["福利項目", [...(d.welfare?.tag ?? []), ...(d.welfare?.legalTag ?? [])].join("、")]]),
    "", d.welfare?.welfare ?? "",
  ];
  return {
    title: `${d.header?.jobName ?? ""}｜${d.header?.custName ?? ""}`,
    markdown: lines.join("\n"),
  };
}

const engine = ENGINES[location.hostname];
const linkSelector = () => (typeof engine.links === "function" ? engine.links() : engine.links);
const canReorder = () => (typeof engine.reorder === "function" ? engine.reorder() : engine.reorder !== false);
const results = new Map(); // url -> result, or { loading: true } while in flight
// anchor -> url its box shows. Not a plain "seen" set: 104's virtual list reuses the same
// anchor elements for different jobs as you scroll, so an anchor must follow its current URL.
const shown = new WeakMap();
let pending = new Set(); // urls waiting to be sent
let timer = null;
let queryWaits = 0; // flushes deferred because the page hasn't exposed its query yet
const MAX_QUERY_WAITS = 10;

const CATEGORY_LABEL = {
  docs: "文件", tutorial: "教學", qa: "問答", news: "新聞",
  research: "研究", blog: "部落格", product: "產品", other: "其他",
};

function realUrl(a) {
  try {
    const u = new URL(a.href);
    // Google's redirect links (/url?q=…) point at the results page's own domain (google.com, google.com.tw).
    if (u.hostname === location.hostname && location.hostname.includes("google.") && u.pathname === "/url") {
      return u.searchParams.get("q") || u.searchParams.get("url");
    }
    return engine.canonical ? engine.canonical(u) : u.href;
  } catch {
    return null;
  }
}

function scan() {
  if (!engine) return;
  for (const a of document.querySelectorAll(linkSelector())) {
    const url = realUrl(a);
    if (!url || !/^https?:/.test(url) || shown.get(a) === url) continue;
    shown.set(a, url);
    if (!results.has(url)) {
      results.set(url, { loading: true });
      pending.add(url);
    }
    mount(a, results.get(url));
  }
  if (pending.size && !timer) timer = setTimeout(flush, 300);
}

/** Redraw every anchor currently showing `url`. */
function render(url) {
  for (const a of document.querySelectorAll(linkSelector())) {
    if (shown.get(a) === url) mount(a, results.get(url));
  }
}

async function flush() {
  timer = null;
  const query = engine.query();
  if (!query) {
    // Some sites (104) only fill in their search description after rendering; retry briefly.
    if (++queryWaits <= MAX_QUERY_WAITS) {
      timer = setTimeout(flush, 500);
    } else {
      for (const url of pending) {
        results.set(url, { error: "找不到搜尋條件" });
        render(url);
      }
      pending = new Set();
    }
    return;
  }
  queryWaits = 0;
  const urls = [...pending];
  pending = new Set();
  // Small batches for pages the Worker must fetch, so one slow site doesn't hold up the
  // rest; job sites send whole batches (their content comes along, and triage wants them together).
  const batchSize = engine.mode === "job" ? 10 : 3;

  for (let i = 0; i < urls.length; i += batchSize) {
    const chunk = urls.slice(i, i + batchSize);
    const pages = engine.content ? await collectPages(chunk) : undefined;
    chrome.runtime.sendMessage({ type: "score", query, urls: chunk, pages, mode: engine.mode }, (resp) => {
      for (const url of chunk) {
        results.set(url, resp?.results?.find((x) => x.url === url) ?? { error: resp?.error ?? "no response" });
        render(url);
      }
      applyOrder();
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
  box.dataset.url = shown.get(anchor) ?? ""; // which result this box shows (anchors get recycled on 104)

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
  box.append(badge(String(data.score), tier));
  if (data.kind === "job") {
    const toneClass = { warn: "ls-warn", good: "ls-good", muted: "ls-muted" };
    if (data.flag) box.append(badge(data.flag.label, toneClass[data.flag.tone] ?? "ls-good"));
  } else {
    box.append(badge(CATEGORY_LABEL[data.category] ?? data.category, "ls-cat"));
    if (data.seoSpam > 0.6) box.append(badge("SEO", "ls-spam"));
    // A sales page is only worth flagging when the search isn't about buying.
    if (data.promotional > 0.6 && data.transactional < 0.5) box.append(badge("銷售頁", "ls-warn"));
  }
  if (data.keyPassage) box.append(passageBlock(data.keyPassage));
  box.title = data.kind === "job" ? jobTooltip(data) : pageTooltip(data);
}

function pageTooltip(d) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  return [
    `相關度 ${d.relevance.toFixed(1)}/4 · 內容深度 ${d.depth.toFixed(1)}/3`,
    `SEO 灌水 ${pct(d.seoSpam)} · 銷售頁 ${pct(d.promotional ?? 0)}`,
    `搜尋意圖：${(d.transactional ?? 0) >= 0.5 ? "購物／找店家（不扣銷售頁分數）" : "查資料"}（${pct(d.transactional ?? 0)}）`,
    `via ${d.source}`,
  ].join("\n");
}

function jobTooltip(d) {
  if (d.screened) {
    return `職稱初篩：從職稱、公司、地點看，跟你的求職條件明顯不符（${Math.round(d.plausible * 100)}%），所以沒有做完整評分。`;
  }
  const n = (v, max) => (v == null ? "—（未填求職條件）" : `${v.toFixed(1)}/${max}`);
  const pct = (v) => `${Math.round(v * 100)}%`;
  return [
    `能力吻合 ${n(d.skillsFit, 4)}`,
    `想做的工作 ${d.skillsFit != null && d.interestFit == null ? "—（求職條件沒寫想做的工作）" : n(d.interestFit, 4)}`,
    `條件符合 ${n(d.conditionsFit, 3)}`,
    `中高齡友善 ${n(d.ageFriendly, 3)}`,
    `搜尋相關 ${n(d.relevance, 4)}`,
    `可遠端 ${pct(d.flags.remote)} · 時間彈性 ${pct(d.flags.flexible)} · 加班輪班 ${pct(d.flags.overtime)} · 體力 ${pct(d.flags.physical)} · 偏好年輕 ${pct(d.flags.young)}`,
    `via ${d.source}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Translating English passages with Chrome's built-in, on-device Translator API.
// The first use downloads the model, which Chrome only allows after a click; once
// it's on the device, passages translate automatically (if enabled in options).
// ---------------------------------------------------------------------------

const TRANSLATE = { sourceLanguage: "en", targetLanguage: "zh-Hant" };
const translations = new Map(); // English passage -> Chinese
let translator = null; // Promise<Translator>
let autoWanted = true; // options page setting
let autoTranslate = false; // wanted, and the model is on the device

if ("Translator" in self) {
  chrome.storage.sync.get({ autoTranslate: true }).then(async ({ autoTranslate: wanted }) => {
    autoWanted = wanted;
    if (wanted && (await Translator.availability(TRANSLATE)) === "available") {
      autoTranslate = true;
      translateAll();
    }
  });
}

function translateAll() {
  for (const b of document.querySelectorAll(".ls-passage[data-english]")) b.lsTranslate?.();
}

/** Mostly Latin letters and little CJK: worth offering a translation. */
function isEnglish(text) {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return latin >= 30 && latin > cjk * 3;
}

function getTranslator(onProgress) {
  translator ??= Translator.create({
    ...TRANSLATE,
    monitor: (m) => m.addEventListener("downloadprogress", (e) => onProgress(e.loaded)),
  }).catch((err) => {
    translator = null; // allow a retry
    throw err;
  });
  return translator;
}

function passageBlock(text) {
  const block = document.createElement("blockquote");
  block.className = "ls-passage";
  const body = document.createElement("span");
  body.textContent = text;
  block.append(body);
  if (!("Translator" in self) || !isEnglish(text)) return block;

  block.dataset.english = "";
  const button = document.createElement("button");
  button.className = "ls-translate";
  block.append(button);

  let showing = "original";
  const showOriginal = () => {
    body.textContent = text;
    button.textContent = "翻成中文";
    showing = "original";
  };
  const showTranslation = async () => {
    if (!translations.has(text)) {
      button.disabled = true;
      button.textContent = "翻譯中…";
      try {
        const t = await getTranslator((loaded) => (button.textContent = `下載翻譯模型 ${Math.round(loaded * 100)}%`));
        translations.set(text, await t.translate(text));
        if (autoWanted && !autoTranslate) {
          // The first click just downloaded the model: translate the rest of this page too,
          // not only passages rendered from now on.
          autoTranslate = true;
          setTimeout(translateAll);
        }
      } catch (err) {
        button.disabled = false;
        button.textContent = "翻成中文";
        button.title = `無法翻譯：${err.message}`;
        return;
      }
      button.disabled = false;
    }
    body.textContent = translations.get(text);
    button.textContent = "顯示原文";
    showing = "translated";
  };

  showOriginal();
  button.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showing === "original" ? showTranslation() : showOriginal();
  };
  // Lets the startup check translate passages that rendered before it finished.
  block.lsTranslate = () => showing === "original" && showTranslation();
  if (autoTranslate || translations.has(text)) showTranslation();
  return block;
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = `ls-badge ${cls}`;
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// Reordering by score. Only the visual order changes (CSS `order` in a flex column);
// the DOM is never moved, so the site's own scripts (104 re-renders its list) keep
// working, and "restore" just removes the styles.
// ---------------------------------------------------------------------------

const scoreOf = (a) => results.get(shown.get(a))?.score;
let reorderOn = true; // per page; the default comes from the options page
const styled = new Set(); // elements we gave inline styles to, for restore

chrome.storage.sync.get({ reorder: true }).then((v) => {
  reorderOn = v.reorder;
  applyOrder();
});

function applyOrder() {
  if (!engine || !canReorder()) return;
  restoreOrder();
  const anchors = [...document.querySelectorAll(linkSelector())].filter((a) => typeof scoreOf(a) === "number");
  if (reorderOn && anchors.length >= 2) {
    const moved = reorderWithin(anchors);
    showToast(moved);
  } else if (anchors.length >= 2) {
    showToast(0);
  }
}

/**
 * Sort the results that are siblings under their closest common container. A sibling
 * holding several results (e.g. a grouped block) stays put and is sorted inside.
 * Non-result siblings (ads, "People also ask") keep their slots. Returns how many moved.
 */
function reorderWithin(anchors) {
  if (anchors.length < 2) return 0;
  const parent = commonAncestor(anchors);
  if (!parent) return 0;

  const groups = new Map(); // child of parent -> anchors inside it
  for (const a of anchors) {
    let child = a;
    while (child.parentElement !== parent) child = child.parentElement;
    groups.set(child, [...(groups.get(child) ?? []), a]);
  }

  let moved = 0;
  const singles = [];
  for (const [child, inside] of groups) {
    if (inside.length === 1) singles.push({ child, score: scoreOf(inside[0]) });
    else moved += reorderWithin(inside);
  }
  if (singles.length < 2) return moved;

  const children = [...parent.children];
  const index = new Map(children.map((c, i) => [c, i]));
  // Slots the results occupy, in page order; results sorted best first (ties keep page order).
  const slots = singles.map((x) => index.get(x.child)).sort((a, b) => a - b);
  const ranked = [...singles].sort((a, b) => b.score - a.score || index.get(a.child) - index.get(b.child));

  setStyle(parent, { display: "flex", flexDirection: "column" });
  children.forEach((c, i) => setStyle(c, { order: String(i) }));
  ranked.forEach((x, i) => {
    if (slots[i] !== index.get(x.child)) moved++;
    x.child.style.order = String(slots[i]);
  });
  return moved;
}

function commonAncestor(nodes) {
  let candidate = nodes[0].parentElement;
  while (candidate && !nodes.every((n) => candidate.contains(n))) candidate = candidate.parentElement;
  return candidate;
}

function setStyle(el, props) {
  if (!styled.has(el)) {
    el.dataset.lsStyle = el.getAttribute("style") ?? "";
    styled.add(el);
  }
  Object.assign(el.style, props);
}

function restoreOrder() {
  for (const el of styled) {
    if (el.dataset.lsStyle) el.setAttribute("style", el.dataset.lsStyle);
    else el.removeAttribute("style");
    delete el.dataset.lsStyle;
  }
  styled.clear();
}

let toast = null;
function showToast(moved) {
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "ls-toast";
    document.body.append(toast);
  }
  const text = document.createElement("span");
  text.textContent = reorderOn ? `LinkScout：已依分數排序（移動 ${moved} 筆）` : "LinkScout：原始順序";
  const button = document.createElement("button");
  button.textContent = reorderOn ? "還原原始順序" : "依分數排序";
  button.onclick = () => {
    reorderOn = !reorderOn;
    applyOrder();
  };
  toast.replaceChildren(text, button);
}

scan();
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
