// Finds result links on the SERP (including ones rendered later), sends new ones
// to the background in small batches, and pins a badge + key passage next to each.
//
// Per-site settings:
//   query()        the search terms
//   links          selector for result title links (or a function returning one)
//   canonical(u)   optional: strip tracking params so the same result caches once
//   content(url)   optional: fetch the result's text from inside this page, for sites
//                  that block Browser Run / Jina; returns { title, markdown } or null
//   mode           optional: "job" scores results as job postings; search engines use
//                  "monitor" instead when monitoring mode is on in the options page
//   reorder        optional: false (or a function returning false) where results must keep the site's order
//   news()         optional: true on the site's news search, where every result is news, so
//                  results get a news type (report, press release, sponsored…) instead of a category
//   panel          optional: true shows a side panel ranking every scored result (needed on
//                  sites that can't be reordered in place; elsewhere a scannable summary)
//   meta(a, url)   optional: { title, sub } for a result's panel row; default is the link text
//   keepGroups     optional: true (or a function) to sort a block of several results as one unit,
//                  by its best score, without touching its inside

const param = (name) => () => new URLSearchParams(location.search).get(name);

// Google's News tab (tbm=nws) titles are [role=heading] cards, not <h3>. Some results are
// story blocks of four cards in a 2×2 grid, which sorting inside would collapse, so the
// blocks move as units.
const isGoogleNews = () => param("tbm")() === "nws";

// Panel row for a search result: the link can also hold the site name, breadcrumbs or a
// snippet, so the heading alone is the title, with the site's domain under it.
const searchMeta = (a, url) => ({
  title: (a.querySelector('h2, h3, [role="heading"]') ?? a).textContent.trim(),
  sub: new URL(url).hostname.replace(/^www\./, ""),
});

const GOOGLE = {
  query: param("q"),
  links: () => (isGoogleNews() ? '#search a:has([role="heading"])' : "#search a:has(h3)"),
  keepGroups: isGoogleNews,
  news: isGoogleNews,
  content: fetchArticle,
  panel: true,
  meta: searchMeta,
};

const ENGINES = {
  "www.google.com": GOOGLE,
  "www.google.com.tw": GOOGLE,
  "www.bing.com": {
    query: param("q"),
    // News (/news/search) is a plain list of .news-card items with direct article links.
    links: () => (location.pathname.startsWith("/news/") ? "#algocore .news-card a.title" : "#b_results li.b_algo h2 a"),
    news: () => location.pathname.startsWith("/news/"),
    content: fetchArticle,
    panel: true,
    meta: searchMeta,
  },
  "duckduckgo.com": {
    query: param("q"),
    // News (ia=news) cards are each one <a> wrapping source, title and snippet.
    links: () =>
      param("ia")() === "news"
        ? '[data-testid="news-vertical"] li > article > a[href^="http"]'
        : 'a[data-testid="result-title-a"]',
    news: () => param("ia")() === "news",
    content: fetchArticle,
    panel: true,
    meta: searchMeta,
  },
  "www.104.com.tw": {
    query: query104,
    links: 'h2 a[href*="/job/"]',
    canonical: (u) => u.origin + u.pathname, // drop ?jobsource=…
    content: fetch104Job,
    // 104's list is virtual: ~22 elements are recycled for whichever jobs are on screen,
    // so sorting them would shuffle jobs around while scrolling. The panel ranks them instead.
    reorder: false,
    panel: true,
    meta: (a) => ({
      title: a.textContent.trim(),
      sub: a.closest(".info-container")?.querySelector('a[href*="/company/"]')?.textContent.trim() ?? "",
      // "兩週內應徵人數 0~5 人" → "0~5"; buckets are 0~5, 6~10, 11~30 and 30 人以上.
      applicants: a.closest(".job-summary")?.querySelector(".action-apply__range")?.title.match(/\d+~\d+/)?.[0],
      jobNo: parseInt(new URL(a.href).pathname.split("/").pop(), 36),
      // The date a job was last refreshed, "10/05"; promoted jobs show an icon here instead.
      date: cardDate(a.closest(".job-summary")?.querySelector(".date-container")?.textContent),
    }),
    mode: "job", // score as job postings against the profile from the options page
  },
};

// ---------------------------------------------------------------------------
// Fast mode: the browser fetches each result page itself (via the background, which
// has the optional <all_urls> permission) and extracts the article with Mozilla
// Readability, the engine behind Firefox Reader View. News sites answer in well under
// a second this way, against 3–30 s through Browser Run or Jina. Pages that fail here
// (logins, bot walls, script-only pages) are left for the Worker to fetch as before.
// ---------------------------------------------------------------------------

/** Below this much article text, let the Worker try instead (paywall stub, challenge page). */
const MIN_ARTICLE_CHARS = 300;
let fastMode = null; // Promise<boolean>, asked once per page

async function fetchArticle(url) {
  fastMode ??= chrome.runtime.sendMessage({ type: "fastMode" }).catch(() => false);
  if (!(await fastMode)) return null;
  const res = await chrome.runtime.sendMessage({ type: "fetchHtml", url });
  if (!res?.html) return null;

  // DOMParser documents are inert: no scripts run and nothing loads. A <base> tag still gets
  // applied, and the search page's CSP (Google: base-uri 'self') reports it as an error; the
  // text extraction doesn't need it, so drop it first.
  const doc = new DOMParser().parseFromString(res.html.replace(/<base\b[^>]*>/gi, ""), "text/html");
  const enough = (md) => md && md.replace(/\s+/g, "").length >= MIN_ARTICLE_CHARS;

  // The publisher's own article text for search engines, where present, beats Readability's
  // guess: on bnext.com.tw Readability picked a sponsored story over the article.
  const ld = ldArticle(doc);
  const ldMarkdown = ld?.body && (/<[a-z]/i.test(ld.body) ? articleMarkdown(ld.body) : textMarkdown(ld.body));
  if (enough(ldMarkdown)) return { title: ld.title || doc.title, markdown: ldMarkdown, via: "browser" };

  const article = new Readability(doc).parse(); // consumes doc, so it runs last
  const markdown = article?.content && articleMarkdown(article.content);
  return enough(markdown) ? { title: article.title || doc.title, markdown, via: "browser" } : null;
}

/** articleBody and headline from the page's JSON-LD (schema.org NewsArticle and kin). */
function ldArticle(doc) {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue; // some sites ship invalid JSON-LD
    }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop();
      if (Array.isArray(x)) stack.push(...x);
      else if (x && typeof x === "object") {
        if (typeof x.articleBody === "string") return { body: x.articleBody, title: x.headline };
        stack.push(...Object.values(x));
      }
    }
  }
  return null;
}

/**
 * Plain article text → paragraphs. Some sites put the whole article on one line, which
 * would leave one oversized passage to choose from, so long runs split at sentence ends.
 */
function textMarkdown(text) {
  const paras = [];
  for (const line of text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    let chunk = "";
    for (const sentence of line.match(/[^。！？!?]+[。！？!?」』]*|[^。！？!?]+$/g) ?? [line]) {
      chunk += sentence;
      if (chunk.length >= 200) {
        paras.push(chunk.trim());
        chunk = "";
      }
    }
    if (chunk.trim()) paras.push(chunk.trim());
  }
  return paras.join("\n\n");
}

const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table";
const CONTAINERS = /^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|UL|OL)$/;

/**
 * Article HTML (Readability's output, or a JSON-LD articleBody) → the Markdown the Worker
 * expects: one block per paragraph. Handles WordPress-style bodies too, where paragraphs
 * are bare text separated by blank lines or <br><br> rather than wrapped in <p>.
 */
function articleMarkdown(html) {
  const root = new DOMParser().parseFromString(html, "text/html").body;
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
  const out = [];
  const walk = (el) => {
    let inline = ""; // bare text and inline elements since the last block
    const flushInline = () => {
      for (const part of inline.split(/\n\s*\n/)) {
        const t = part.replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      }
      inline = "";
    };
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) inline += c.textContent;
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = c.tagName;
      if (tag === "BR") {
        inline += "\n";
        continue;
      }
      const block = /^(H[1-6]|P|LI|BLOCKQUOTE|PRE|TABLE)$/.test(tag) || CONTAINERS.test(tag) || c.querySelector(BLOCKS);
      if (!block) {
        inline += c.textContent;
        continue;
      }
      flushInline();
      if (/^H[1-6]$/.test(tag)) out.push(`${"#".repeat(Number(tag[1]))} ${text(c)}`);
      else if (tag === "P") out.push(text(c));
      else if (tag === "LI") out.push(`- ${text(c)}`);
      else if (tag === "BLOCKQUOTE") out.push(`> ${text(c)}`);
      else if (tag === "PRE") out.push("```\n" + c.textContent.trim() + "\n```");
      else if (tag === "TABLE") {
        for (const row of c.querySelectorAll("tr")) out.push(`| ${[...row.cells].map(text).join(" | ")} |`);
      } else walk(c);
    }
    flushInline();
  };
  walk(root);
  return out.filter((b) => b.replace(/^[-#>|\s]+/, "")).join("\n\n");
}

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
const keepGroups = () => (typeof engine.keepGroups === "function" ? engine.keepGroups() : !!engine.keepGroups);
const canReorder = () => (typeof engine.reorder === "function" ? engine.reorder() : engine.reorder !== false);
const results = new Map(); // url -> result, or { loading: true } while in flight
const meta = new Map(); // url -> { title, sub } for the ranking panel
// anchor -> url its box shows. Not a plain "seen" set: 104's virtual list reuses the same
// anchor elements for different jobs as you scroll, so an anchor must follow its current URL.
const shown = new WeakMap();
let pending = new Set(); // urls waiting to be sent
let timer = null;
let queryWaits = 0; // flushes deferred because the page hasn't exposed its query yet
const MAX_QUERY_WAITS = 10;

// Monitoring mode: search results are sorted into media-monitoring report sections for the
// client described in the options page. Needs both the switch and a client description.
let monitorOn = false;
let monitorClient = ""; // first line of the client description, to tell marks apart
const settingsReady = Promise.all([
  i18nReady,
  chrome.storage.sync
    .get({ monitorMode: false, monitorProfile: "" })
    .then((v) => {
      monitorOn = v.monitorMode && v.monitorProfile.trim() !== "";
      monitorClient = v.monitorProfile.trim().split("\n")[0].slice(0, 80);
    })
    .catch(() => {}),
]);
const currentMode = () => engine.mode ?? (monitorOn ? "monitor" : undefined);

const TONE_CLASS = { positive: "ls-good", neutral: "ls-cat", negative: "ls-warn" };
// Paid or reprinted content is worth a second look in a report; the rest is plain context.
const NEWS_TYPE_CLASS = { sponsored: "ls-warn", press_release: "ls-muted", aggregated: "ls-muted" };
const newsTypeBadge = (t) => badge(label("newsType", t), NEWS_TYPE_CLASS[t] ?? "ls-cat");

// Uncertain exclusions stay visible for a human to check: hiding a real article costs more.
const monitored = (d) => d.section === "exposure" || d.section === "industry" || d.uncertain;

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
    if (!meta.has(url)) {
      const m = engine.meta ? engine.meta(a, url) : { title: a.textContent.trim(), sub: "" };
      meta.set(url, m);
      if (m.jobNo && m.date) noteJob(m.jobNo, m.date);
    }
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
  schedulePanel();
}

async function flush() {
  timer = null;
  if (!alive()) return;
  await settingsReady;
  const query = engine.query();
  if (!query) {
    // Some sites (104) only fill in their search description after rendering; retry briefly.
    if (++queryWaits <= MAX_QUERY_WAITS) {
      timer = setTimeout(flush, 500);
    } else {
      for (const url of pending) {
        results.set(url, { error: L("noQuery") });
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

  // Chunks go out in parallel, so a slow page in one chunk doesn't delay the next.
  for (let i = 0; i < urls.length; i += batchSize) {
    const chunk = urls.slice(i, i + batchSize);
    (engine.content ? collectPages(chunk) : Promise.resolve(undefined)).then((pages) => {
      const news = engine.news?.() ?? false;
      chrome.runtime.sendMessage({ type: "score", query, urls: chunk, pages, mode: currentMode(), news }, (resp) => {
        // No response: the extension was reloaded mid-request (this page now runs a dead copy
        // of the script), or the background failed; lastError says which.
        const lost = alive()
          ? chrome.runtime.lastError?.message ?? "no response"
          : L("reloaded");
        for (const url of chunk) {
          results.set(url, resp?.results?.find((x) => x.url === url) ?? { error: resp?.error ?? lost });
          render(url);
        }
        applyOrder();
      });
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
    box.append(badge(L("unreadable"), "ls-error"));
    box.title = data.error;
    return;
  }

  if (data.kind === "monitor" && !monitored(data)) {
    // Stock-market and unrelated articles stay out of the report: muted, no passage.
    box.append(badge(String(data.score), "ls-muted"), badge(label("section", data.section), "ls-muted"));
    box.append(markButtons(box.dataset.url, data, anchor));
    box.title = monitorTooltip(data);
    return;
  }
  const tier = data.score >= 70 ? "ls-high" : data.score >= 40 ? "ls-mid" : "ls-low";
  box.append(badge(String(data.score), tier));
  if (data.kind === "monitor") {
    // Tone is about the client, so it only labels coverage of the client.
    box.append(sectionBadge(data));
    box.append(badge(label("topic", data.topic), "ls-cat"));
    if (data.newsType) box.append(newsTypeBadge(data.newsType));
  } else if (data.kind === "job") {
    if (data.flag) box.append(flagBadge(data.flag));
    const ai = aiBadge(data);
    if (ai) box.append(ai);
  } else {
    box.append(data.newsType ? newsTypeBadge(data.newsType) : badge(label("category", data.category), "ls-cat"));
    if (data.seoSpam > 0.6) box.append(badge("SEO", "ls-spam"));
    // A sales page is only worth flagging when the search isn't about buying.
    if (data.promotional > 0.6 && data.transactional < 0.5) box.append(badge(L("salesPage"), "ls-warn"));
  }
  if (data.keyPassage) box.append(passageBlock(data.keyPassage));
  if (data.kind === "monitor") box.append(markButtons(box.dataset.url, data, anchor));
  box.title = data.kind === "job" ? jobTooltip(data) : data.kind === "monitor" ? monitorTooltip(data) : pageTooltip(data);
}

/** The report-section badge for a monitored article: exposure · tone, industry, or "check". */
function sectionBadge(d) {
  if (d.section === "exposure") return badge(L("exposureTone", label("tone", d.tone)), TONE_CLASS[d.tone]);
  if (d.section === "industry") return badge(label("section", "industry"), "ls-cat");
  if (d.uncertain) return badge(L("uncertain", label("sectionShort", d.section)), "ls-warn");
  return badge(label("section", d.section), "ls-muted");
}

/** A 104 job's flag. Flags cached before the Worker sent `key` only have the Chinese label. */
function flagBadge(flag) {
  const toneClass = { warn: "ls-warn", good: "ls-good", muted: "ls-muted" };
  return badge(flag.key ? label("flag", flag.key) : flag.label, toneClass[flag.tone] ?? "ls-good");
}

const pct = (v) => `${Math.round(v * 100)}%`;

function monitorTooltip(d) {
  const level = (v, names) => L("level", L(names)[Math.round(v)], v.toFixed(1));
  return [
    L("reportSection", label("section", d.section), pct(d.sectionConfidence), d.uncertain),
    L("toneTopic", label("tone", d.tone), label("topic", d.topic), d.newsType && label("newsType", d.newsType)),
    L("prominence", level(d.prominence, "prominenceLevels")),
    L("importance", level(d.importance, "importanceLevels")),
    `via ${d.source}`,
  ].join("\n");
}

function pageTooltip(d) {
  return [
    L("relevanceDepth", d.relevance.toFixed(1), d.depth.toFixed(1)),
    L("spamSales", pct(d.seoSpam), pct(d.promotional ?? 0)),
    L("intent", (d.transactional ?? 0) >= 0.5, pct(d.transactional ?? 0)),
    `via ${d.source}`,
  ].join("\n");
}

// 104 shows how many applied in the last two weeks. Few applicants means a better chance,
// but it says nothing about fit, so it's a badge, not points. Only in the panel: the job
// card already shows the count next to the result.
const FEW_APPLICANTS = ["0~5", "6~10"];
const fewApplicantsBadge = (url) => {
  const n = meta.get(url)?.applicants;
  return FEW_APPLICANTS.includes(n) ? badge(`${n} ${L("applicants")}`, n === "0~5" ? "ls-few" : "ls-few ls-few-soft") : null;
};

// When was a job first posted? 104 only shows the date it was last refreshed, and employers
// refresh old jobs daily. But job numbers (the base-36 id in /job/96god) only grow, so a job
// numbered N refreshed on day D means every job numbered up to N existed by D. Each list card
// adds such a point, and the highest number seen for each day is kept: a job was posted by
// the first day whose number reaches it, and is new when its number is above everything
// known from NEW_DAYS ago. The more 104 pages are seen, the tighter this gets.
const NEW_DAYS = 7;
const KEEP_DAYS = 180;
// From 570 jobs seen on 2026-10-06, so it works before much browsing.
let jobFrontier = { "2026-08-27": 15363346, "2026-09-30": 15400358, "2026-10-02": 15414586 };
let frontierTimer = null;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortDate = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8)}`;
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 86400000));

/** "10/05" → "2026-10-05"; a date after today is from last year. */
function cardDate(text) {
  const md = text?.match(/(\d{1,2})\/(\d{1,2})/);
  if (!md) return undefined;
  const now = new Date();
  const d = new Date(now.getFullYear(), md[1] - 1, md[2]);
  if (d > now) d.setFullYear(d.getFullYear() - 1);
  return isoDate(d);
}

function mergeFrontier(into, from) {
  for (const [day, n] of Object.entries(from ?? {})) if (!(into[day] >= n)) into[day] = n;
  return into;
}

chrome.storage.local
  .get({ jobFrontier: {} })
  .then((v) => mergeFrontier(jobFrontier, v.jobFrontier))
  .catch(() => {});

function noteJob(jobNo, day) {
  if (jobFrontier[day] >= jobNo) return;
  jobFrontier[day] = jobNo;
  frontierTimer ??= setTimeout(saveFrontier, 2000);
}

async function saveFrontier() {
  frontierTimer = null;
  try {
    const { jobFrontier: stored } = await chrome.storage.local.get({ jobFrontier: {} });
    const all = mergeFrontier(stored, jobFrontier);
    const oldest = daysAgo(KEEP_DAYS);
    for (const day of Object.keys(all)) if (day < oldest) delete all[day];
    await chrome.storage.local.set({ jobFrontier: all });
  } catch {} // extension reloaded: the next page load saves again
}

/** The day by which job `jobNo` existed at the latest, or null if nothing known reaches it. */
function postedBy(jobNo) {
  if (!jobNo) return null;
  let max = 0;
  for (const day of Object.keys(jobFrontier).sort()) {
    max = Math.max(max, jobFrontier[day]);
    if (max >= jobNo) return day;
  }
  return null;
}

const isNewJob = (jobNo) => {
  const day = postedBy(jobNo);
  return !!jobNo && (!day || day > daysAgo(NEW_DAYS));
};

// Jobs whose day-to-day work AI tools speed up a lot: a strength for someone who uses them.
// Shown, not scored. Past 2 ("a large share is writing, information, or data work"): an
// office assistant who also answers phones and greets visitors scored 2.0, news monitoring,
// social media and bookkeeping 2.9–3.0, warehouse and front-desk jobs under 0.3.
const AI_BADGE_MIN = 2.5;
const aiBadge = (d) => (d.aiLeverage >= AI_BADGE_MIN ? badge(L("aiLeverage"), "ls-few") : null);

function jobTooltip(d) {
  if (d.screened) return L("screenedJob", pct(d.plausible));
  const n = (v, max) => (v == null ? L("noProfile") : `${v.toFixed(1)}/${max}`);
  const f = d.flags;
  return [
    `${L("skillsFit")} ${n(d.skillsFit, 4)}`,
    `${L("interestFit")} ${d.skillsFit != null && d.interestFit == null ? L("noInterest") : n(d.interestFit, 4)}`,
    `${L("conditionsFit")} ${n(d.conditionsFit, 3)}`,
    `${L("ageFriendly")} ${n(d.ageFriendly, 3)}`,
    `${L("searchRelevance")} ${n(d.relevance, 4)}`,
    L("jobFlags", { remote: pct(f.remote), flexible: pct(f.flexible), overtime: pct(f.overtime), physical: pct(f.physical), young: pct(f.young) }),
    d.aiLeverage != null && `${L("aiLeverageLevel")} ${d.aiLeverage.toFixed(1)}/3`,
    `via ${d.source}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Translating English passages with Chrome's built-in, on-device Translator API.
// The first use downloads the model, which Chrome only allows after a click; once
// it's on the device, passages translate automatically (if enabled in options).
// Only with the Chinese interface: an English reader has no use for it.
// ---------------------------------------------------------------------------

const TRANSLATE = { sourceLanguage: "en", targetLanguage: "zh-Hant" };
const translations = new Map(); // English passage -> Chinese
let translator = null; // Promise<Translator>
let autoWanted = true; // options page setting
let autoTranslate = false; // wanted, and the model is on the device

const translating = () => "Translator" in self && uiLang === "zh";

if ("Translator" in self) {
  Promise.all([i18nReady, chrome.storage.sync.get({ autoTranslate: true })]).then(async ([, { autoTranslate: wanted }]) => {
    autoWanted = wanted;
    if (!translating()) return;
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
  if (!translating() || !isEnglish(text)) return block;

  block.dataset.english = "";
  const button = document.createElement("button");
  button.className = "ls-translate";
  block.append(button);

  let showing = "original";
  const showOriginal = () => {
    body.textContent = text;
    button.textContent = L("translate");
    showing = "original";
  };
  const showTranslation = async () => {
    if (!translations.has(text)) {
      button.disabled = true;
      button.textContent = L("translating");
      try {
        const t = await getTranslator((loaded) => (button.textContent = L("downloadingModel", Math.round(loaded * 100))));
        translations.set(text, await t.translate(text));
        if (autoWanted && !autoTranslate) {
          // The first click just downloaded the model: translate the rest of this page too,
          // not only passages rendered from now on.
          autoTranslate = true;
          setTimeout(translateAll);
        }
      } catch (err) {
        button.disabled = false;
        button.textContent = L("translate");
        button.title = L("cantTranslate", err.message);
        return;
      }
      button.disabled = false;
    }
    body.textContent = translations.get(text);
    button.textContent = L("showOriginal");
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
  const all = [...document.querySelectorAll(linkSelector())];
  const anchors = all.filter((a) => typeof scoreOf(a) === "number");
  if (reorderOn && anchors.length >= 2) {
    // Keeping groups: sort under the container of every result, even while only the ones
    // inside one block are scored, so a block is never sorted from the inside.
    const moved = keepGroups() ? reorderWithin(anchors, commonAncestor(all), true) : reorderWithin(anchors);
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
function reorderWithin(anchors, parent = commonAncestor(anchors), wholeGroups = false) {
  if (anchors.length < 2 || !parent) return 0;

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
    else if (wholeGroups) singles.push({ child, score: Math.max(...inside.map(scoreOf)) });
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
  text.textContent = reorderOn ? L("sorted", moved) : L("originalOrder");
  const button = document.createElement("button");
  button.textContent = reorderOn ? L("restoreOrder") : L("sortByScore");
  button.onclick = () => {
    reorderOn = !reorderOn;
    applyOrder();
  };
  toast.replaceChildren(text, button);
}

// ---------------------------------------------------------------------------
// Ranking panel: every result scored so far, best first, without touching the site's own
// list. On 104 it is the only ranking (its virtual list can't be reordered); on Google it is
// a compact overview next to the reordered results.
// ---------------------------------------------------------------------------

let panel = null;
let panelQueued = false;
let panelCollapsed = false;

function schedulePanel() {
  if (!engine?.panel || panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => {
    panelQueued = false;
    drawPanel();
  });
}

function drawPanel() {
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "ls-panel";
    document.body.append(panel);
    chrome.storage.local.get({ panelCollapsed: false }).then((v) => {
      panelCollapsed = v.panelCollapsed;
      drawPanel();
    });
  }
  const all = [...results].map(([url, r]) => ({ url, r, m: meta.get(url) ?? { title: url, sub: "" } }));
  const byScore = (a, b) => b.r.score - a.r.score;
  const ranked = all.filter((e) => typeof e.r.score === "number" && !e.r.screened).sort(byScore);
  const screened = all.filter((e) => e.r.screened).sort(byScore);
  const loading = all.filter((e) => e.r.loading).length;
  const failed = all.filter((e) => e.r.error).length;

  const head = document.createElement("button");
  head.className = "ls-panel-head";
  head.textContent = `${panelCollapsed ? "▸" : "▾"} ${L("panelHead", ranked.length, loading)}`;
  head.onclick = () => {
    panelCollapsed = !panelCollapsed;
    if (alive()) chrome.storage.local.set({ panelCollapsed });
    drawPanel();
  };
  panel.classList.toggle("ls-collapsed", panelCollapsed);
  if (panelCollapsed) return panel.replaceChildren(head);

  const list = document.createElement("div");
  list.className = "ls-panel-list";
  for (const e of [...ranked, ...screened]) list.append(panelRow(e));
  if (!ranked.length && !screened.length) list.append(panelNote(loading ? L("panelScoring") : L("panelEmpty")));

  const notes = [
    screened.length && L("panelScreened", screened.length),
    failed && L("panelFailed", failed),
    engine.mode === "job" ? L("panelJobsNote") : L("panelPageNote"),
  ].filter(Boolean);
  panel.replaceChildren(head, list, panelNote(notes.join(" · ")));
}

function panelRow({ url, r, m }) {
  const row = document.createElement("a");
  row.className = "ls-panel-row";
  row.href = url;
  row.target = "_blank";
  row.rel = "noopener";
  const excluded = r.kind === "monitor" && !monitored(r);
  const tier = r.screened || excluded ? "ls-muted" : r.score >= 70 ? "ls-high" : r.score >= 40 ? "ls-mid" : "ls-low";
  const text = document.createElement("span");
  text.className = "ls-panel-text";
  const title = document.createElement("span");
  title.className = "ls-panel-title";
  title.textContent = m.title;
  text.append(title);
  const posted = r.kind === "job" ? postedBy(m.jobNo) : null;
  const subText = [posted && !isNewJob(m.jobNo) && L("postedBy", shortDate(posted)), m.sub].filter(Boolean).join(" · ");
  if (subText) {
    const sub = document.createElement("span");
    sub.className = "ls-panel-sub";
    sub.textContent = subText;
    text.append(sub);
  }
  // Badges on their own line under the title, so a job with three of them keeps a readable title.
  const tags = [];
  if (r.flag) tags.push(flagBadge(r.flag));
  if (r.kind === "job") tags.push(isNewJob(m.jobNo) && badge(L("newJob"), "ls-few"), aiBadge(r), fewApplicantsBadge(url));
  if (r.kind === "monitor") tags.push(sectionBadge(r));
  else if (r.newsType) tags.push(newsTypeBadge(r.newsType));
  const shownTags = tags.filter(Boolean);
  if (shownTags.length) {
    const line = document.createElement("span");
    line.className = "ls-panel-tags";
    line.append(...shownTags);
    text.append(line);
  }
  row.append(badge(String(r.score), tier), text);
  if (r.keyPassage) row.title = r.keyPassage;
  return row;
}

// ---------------------------------------------------------------------------
// Report marks: in monitoring mode, under each result's key passage, a person can record
// whether the result went into the report. They are only collected, in chrome.storage.local,
// and exported from the options page, so the scoring can be checked against real decisions.
// ---------------------------------------------------------------------------

let marks = {}; // "query\nurl" -> mark entry
chrome.storage.local.get({ marks: {} }).then((v) => (marks = v.marks)).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.marks) return;
  marks = changes.marks.newValue ?? {};
  for (const wrap of document.querySelectorAll(".ls-marks")) showMark(wrap);
});
const markKey = (url) => `${engine.query()}\n${url}`;

// The verdict fields worth comparing with the person's decision.
const VERDICT_FIELDS = [
  "score", "section", "sectionConfidence", "uncertain", "tone", "topic",
  "newsType", "prominence", "importance", "source",
];

async function setMark(url, r, title, mark) {
  if (!alive()) return;
  const key = markKey(url);
  // Re-read first: another tab may have marked something since this one loaded.
  const { marks: all } = await chrome.storage.local.get({ marks: {} });
  if (all[key]?.mark === mark) {
    delete all[key]; // clicking the active mark again clears it
  } else {
    all[key] = {
      url,
      title,
      query: engine.query(),
      client: monitorClient,
      mark,
      time: new Date().toISOString(),
      verdict: Object.fromEntries(VERDICT_FIELDS.filter((f) => f in r).map((f) => [f, r[f]])),
    };
  }
  await chrome.storage.local.set({ marks: all }); // onChanged updates the buttons
}

function markButtons(url, r, anchor) {
  const wrap = document.createElement("div");
  wrap.className = "ls-marks";
  wrap.dataset.url = url;
  for (const mark of ["include", "exclude"]) {
    const b = document.createElement("button");
    b.className = `ls-mark ls-mark-${mark}`;
    b.dataset.mark = mark;
    b.textContent = L(mark === "include" ? "markInclude" : "markExclude");
    // The box sits inside the result's link on some sites; a mark must not open the result.
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMark(url, r, meta.get(url)?.title ?? anchor.textContent.trim(), mark);
    };
    wrap.append(b);
  }
  showMark(wrap);
  return wrap;
}

function showMark(wrap) {
  const current = marks[markKey(wrap.dataset.url)]?.mark;
  for (const b of wrap.children) b.classList.toggle("ls-mark-on", b.dataset.mark === current);
}

function panelNote(text) {
  const p = document.createElement("div");
  p.className = "ls-panel-note";
  p.textContent = text;
  return p;
}

// When the extension is reloaded or updated, this script keeps running in tabs that were
// already open, but every chrome.* call now throws "Extension context invalidated".
// Stop quietly instead; the page's next load gets the new script.
const alive = () => !!chrome.runtime?.id;

scan();
const observer = new MutationObserver(() => (alive() ? scan() : observer.disconnect()));
observer.observe(document.body, { childList: true, subtree: true });
