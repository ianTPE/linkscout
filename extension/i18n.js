// UI strings in English and Traditional Chinese, shared by the content script, the options
// page and the background. The language follows the browser's unless the options page
// sets one; a change there applies to open pages from their next redraw.
//
//   L(key, ...args)   a string, or a template filled with args
//   label(group, k)   one of a set of labels (section, tone, topic, newsType, category, flag)

const STRINGS = {
  en: {
    noQuery: "Couldn't find the search terms",
    reloaded: "LinkScout was reloaded; refresh this page",
    timeout: "Timed out: the Worker didn't answer within 60 s",
    unreadable: "Can't read",
    salesPage: "Sales page",
    exposureTone: (tone) => `Exposure · ${tone}`,
    uncertain: (section) => `${section}? Check`,

    reportSection: (s, pct, uncertain) => `Report section: ${s} (${pct})${uncertain ? ", low confidence: check by hand" : ""}`,
    toneTopic: (tone, topic, type) => `Tone toward the client: ${tone} · Topic: ${topic}${type ? ` · Type: ${type}` : ""}`,
    prominence: (level) => `Client in the article: ${level}`,
    importance: (level) => `Importance: ${level}`,
    prominenceLevels: ["Not mentioned", "Passing mention", "One of the main subjects", "Main subject"],
    importanceLevels: ["Routine", "Background", "Worth reading", "Major"],
    level: (name, v) => `${name} (${v}/3)`,

    relevanceDepth: (r, d) => `Relevance ${r}/4 · Depth ${d}/3`,
    spamSales: (seo, sales) => `SEO filler ${seo} · Sales page ${sales}`,
    intent: (shopping, pct) =>
      `Search intent: ${shopping ? "shopping or finding a store (sales pages not penalized)" : "research"} (${pct})`,

    screenedJob: (pct) =>
      `Title screening: from the title, company and location, this job clearly doesn't match your profile (${pct}), so it wasn't fully scored.`,
    noProfile: "— (no job profile)",
    noInterest: "— (your profile doesn't say what work you want)",
    skillsFit: "Skills fit",
    interestFit: "Work you want",
    conditionsFit: "Conditions fit",
    ageFriendly: "Age-friendly",
    searchRelevance: "Search relevance",
    jobFlags: (f) =>
      `Remote ${f.remote} · Flexible hours ${f.flexible} · Overtime/shifts ${f.overtime} · Physical ${f.physical} · Prefers young ${f.young}`,

    translate: "Translate to Chinese",
    translating: "Translating…",
    downloadingModel: (pct) => `Downloading translation model ${pct}%`,
    cantTranslate: (msg) => `Can't translate: ${msg}`,
    showOriginal: "Show original",

    sorted: (n) => `LinkScout: sorted by score (${n} moved)`,
    originalOrder: "LinkScout: original order",
    restoreOrder: "Restore original order",
    sortByScore: "Sort by score",

    panelHead: (n, loading) => `LinkScout ranking (${n}${loading ? `, ${loading} scoring` : ""})`,
    panelScoring: "Scoring…",
    panelEmpty: "No scores yet",
    panelScreened: (n) => `${n} screened out (listed last)`,
    panelFailed: (n) => `${n} unreadable`,
    panelJobsNote: "Only jobs that have appeared while scrolling; more are added as you scroll.",
    panelPageNote: "Only results on this page.",
    markInclude: "✓ In the report",
    markExclude: "✗ Leave out",
  },

  zh: {
    noQuery: "找不到搜尋條件",
    reloaded: "擴充功能已重新載入，請重新整理頁面",
    timeout: "逾時：Worker 60 秒內沒有回應",
    unreadable: "無法讀取",
    salesPage: "銷售頁",
    exposureTone: (tone) => `露出・${tone}`,
    uncertain: (section) => `${section}？待確認`,

    reportSection: (s, pct, uncertain) => `報告分類：${s}（${pct}）${uncertain ? "，把握度低，請人工確認" : ""}`,
    toneTopic: (tone, topic, type) => `對客戶的語氣：${tone} · 主題：${topic}${type ? ` · 類型：${type}` : ""}`,
    prominence: (level) => `客戶在報導中：${level}`,
    importance: (level) => `重要性：${level}`,
    prominenceLevels: ["未提及", "順帶提及", "主角之一", "主角"],
    importanceLevels: ["例行", "背景資訊", "值得一看", "重大"],
    level: (name, v) => `${name}（${v}/3）`,

    relevanceDepth: (r, d) => `相關度 ${r}/4 · 內容深度 ${d}/3`,
    spamSales: (seo, sales) => `SEO 灌水 ${seo} · 銷售頁 ${sales}`,
    intent: (shopping, pct) => `搜尋意圖：${shopping ? "購物／找店家（不扣銷售頁分數）" : "查資料"}（${pct}）`,

    screenedJob: (pct) => `職稱初篩：從職稱、公司、地點看，跟你的求職條件明顯不符（${pct}），所以沒有做完整評分。`,
    noProfile: "—（未填求職條件）",
    noInterest: "—（求職條件沒寫想做的工作）",
    skillsFit: "能力吻合",
    interestFit: "想做的工作",
    conditionsFit: "條件符合",
    ageFriendly: "中高齡友善",
    searchRelevance: "搜尋相關",
    jobFlags: (f) =>
      `可遠端 ${f.remote} · 時間彈性 ${f.flexible} · 加班輪班 ${f.overtime} · 體力 ${f.physical} · 偏好年輕 ${f.young}`,

    translate: "翻成中文",
    translating: "翻譯中…",
    downloadingModel: (pct) => `下載翻譯模型 ${pct}%`,
    cantTranslate: (msg) => `無法翻譯：${msg}`,
    showOriginal: "顯示原文",

    sorted: (n) => `LinkScout：已依分數排序（移動 ${n} 筆）`,
    originalOrder: "LinkScout：原始順序",
    restoreOrder: "還原原始順序",
    sortByScore: "依分數排序",

    panelHead: (n, loading) => `LinkScout 排行（${n}${loading ? `，評分中 ${loading}` : ""}）`,
    panelScoring: "評分中…",
    panelEmpty: "還沒有評分結果",
    panelScreened: (n) => `初篩略過 ${n} 筆（列在最後）`,
    panelFailed: (n) => `無法讀取 ${n} 筆`,
    panelJobsNote: "只包含捲動時出現過的職缺；往下捲會繼續加入。",
    panelPageNote: "只包含這一頁的結果。",
    markInclude: "✓ 收進報告",
    markExclude: "✗ 不收",
  },
};

const LABELS = {
  en: {
    section: { exposure: "Exposure", industry: "Industry", stock: "Stock · not monitored", unrelated: "Unrelated" },
    sectionShort: { stock: "Stock", unrelated: "Unrelated" },
    tone: { positive: "Positive", neutral: "Neutral", negative: "Negative" },
    topic: {
      operations: "Operations", product: "Products & tech", investment: "Investment", partnership: "Partners",
      people: "People & governance", legal: "Legal", policy: "Policy", market: "Market trends",
      competitor: "Competitors", esg: "ESG", brand: "Brand & events", other: "Other",
    },
    newsType: {
      report: "Report", analysis: "Analysis", press_release: "Press release",
      sponsored: "Sponsored", aggregated: "Aggregated", other: "Not news",
    },
    category: {
      docs: "Docs", tutorial: "Tutorial", qa: "Q&A", news: "News",
      research: "Research", blog: "Blog", product: "Product", other: "Other",
    },
    flag: {
      overtime: "⚠ Overtime/shifts", physical: "⚠ Physical work", young: "⚠ Prefers young",
      interest: "Work you want", skills: "Skills fit", conditions: "Conditions fit",
      ageFriendly: "Age-friendly", remote: "Remote", flexible: "Flexible hours", screened: "Screened out",
    },
  },
  zh: {
    section: { exposure: "露出", industry: "產業", stock: "股市・不監測", unrelated: "無關" },
    sectionShort: { stock: "股市", unrelated: "無關" },
    tone: { positive: "正面", neutral: "中性", negative: "負面" },
    topic: {
      operations: "營運財務", product: "產品技術", investment: "投資擴廠", partnership: "合作客戶",
      people: "人事治理", legal: "法律訴訟", policy: "政策法規", market: "市場趨勢",
      competitor: "競爭對手", esg: "ESG", brand: "品牌活動", other: "其他",
    },
    newsType: {
      report: "報導", analysis: "分析評論", press_release: "新聞稿",
      sponsored: "業配廣編", aggregated: "彙整轉載", other: "非新聞",
    },
    category: {
      docs: "文件", tutorial: "教學", qa: "問答", news: "新聞",
      research: "研究", blog: "部落格", product: "產品", other: "其他",
    },
    flag: {
      overtime: "⚠ 常加班／輪班", physical: "⚠ 體力負荷重", young: "⚠ 偏好年輕人",
      interest: "想做的工作", skills: "能力吻合", conditions: "條件符合",
      ageFriendly: "中高齡友善", remote: "可遠端", flexible: "時間彈性", screened: "初篩略過",
    },
  },
};

/** "auto" follows the browser: Chinese for any zh-* browser language, else English. */
const resolveLang = (setting) =>
  setting === "en" || setting === "zh" ? setting : /^zh\b/i.test(navigator.language) ? "zh" : "en";

let uiLang = resolveLang("auto");
const i18nReady = chrome.storage.sync
  .get({ uiLanguage: "auto" })
  .then(({ uiLanguage }) => (uiLang = resolveLang(uiLanguage)))
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.uiLanguage) uiLang = resolveLang(changes.uiLanguage.newValue);
});

function L(key, ...args) {
  const s = STRINGS[uiLang][key] ?? STRINGS.en[key] ?? key;
  return typeof s === "function" ? s(...args) : s;
}

/** A label from one of the sets above; unknown keys show as-is. */
const label = (group, key) => LABELS[uiLang][group]?.[key] ?? key;
