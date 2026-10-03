const DEFAULTS = {
  workerUrl: "http://localhost:8787",
  token: "dev-token",
  jobProfile: "",
  reorder: true,
  autoTranslate: true,
  monitorMode: false,
  monitorProfile: "",
};
const $ = (id) => document.getElementById(id);

// Options-page text, added to the shared strings in i18n.js.
Object.assign(STRINGS.en, {
  uiLanguage: "Interface language",
  uiAuto: "Same as the browser",
  uiLanguageHint: "Applies to badges, the ranking panel and this page. Open search pages switch on their next update; refresh them to switch everything.",
  fastMode: "Fast mode: the browser reads result pages itself",
  fastModeHint:
    "Results appear in about 1–2 s (10–20 s with this off). Chrome asks to let the extension \"read all sites\": it needs that to read any news site. Pages are read without your logins, the same as opening the result yourself. Pages that can't be read this way go to the Worker as before. This switch applies at once, no need to Save.",
  reorder: "Sort search results by score",
  reorderHint: "Only changes the order on screen, not the page content; the bar at the bottom right switches back to the original order at any time.",
  autoTranslate: "Translate English key passages into Chinese automatically",
  autoTranslateHint:
    "Uses Chrome's built-in on-device translation; no text leaves your computer. The first time, click \"Translate to Chinese\" on a passage to download the translation model.",
  monitorMode: "News monitoring mode",
  monitorModeHint:
    "Sorts search results for the client described below into Exposure (coverage of the client), Industry (news about the client's industry), Stock (share prices, market moves, institutional trading, ETFs: not monitored) and Unrelated. Stock and unrelated results are muted and sorted last. With this off, results get general search scoring.",
  monitorProfile: "Monitoring client",
  monitorProfilePlaceholder:
    "e.g. Client: TSMC (Taiwan Semiconductor Manufacturing Co., 台積電). Industry: semiconductor foundry; upstream and downstream include IC design, packaging and testing, equipment and materials. Competitors: Samsung, Intel.",
  monitorProfileHint:
    "The client's name, short names or names in other languages, its industry, and any competitors or suppliers to watch, up to 2000 characters. This text goes to your Worker and to Jev; without it, monitoring mode stays off.",
  jobProfile: "Job profile (for 104 job scoring)",
  jobProfilePlaceholder:
    "e.g. 20 years in administration and accounting, good with Excel and ERP systems. Looking for day shifts in Taipei's Zhongzheng or Da'an district, no rotating shifts or heavy lifting, NT$40,000+ a month, some remote work welcome.",
  jobProfileHint:
    "Your background, skills and the job conditions you want, in your own words, up to 2000 characters. This text goes to your Worker and to Jev; left empty, 104 jobs are scored on the search and age-friendliness only.",
  save: "Save",
  saved: "Saved",
});
Object.assign(STRINGS.zh, {
  uiLanguage: "介面語言",
  uiAuto: "跟瀏覽器相同",
  uiLanguageHint: "套用在徽章、排行面板和這個設定頁。已開著的搜尋頁會在下次更新時切換，重新整理才會全部換掉。",
  fastMode: "快速模式：由瀏覽器直接讀取搜尋結果頁面",
  fastModeHint:
    "結果約 1～2 秒內出現（關閉時要 10～20 秒）。Chrome 會詢問是否允許「讀取所有網站」：擴充功能需要它才能讀取任何新聞網站。讀取時不帶你的登入資料，效果等於你自己點開那則結果。讀不到的頁面會自動改由 Worker 讀取。這個開關會立即生效，不用按儲存。",
  reorder: "依分數重新排序搜尋結果",
  reorderHint: "只改變顯示順序，不動頁面內容；頁面右下角可以隨時切換回原始順序。",
  autoTranslate: "自動把英文重點段落翻成中文",
  autoTranslateHint: "使用 Chrome 內建的離線翻譯，不會把文字送出你的電腦。第一次需要在引用框按「翻成中文」下載翻譯模型。",
  monitorMode: "新聞監測模式",
  monitorModeHint:
    "開啟後，搜尋結果改依下方的監測對象分成「露出」（報導客戶本身）、「產業」（客戶所在產業的新聞）、「股市」（股價、盤勢、法人買賣、ETF 等，不監測）和「無關」。股市和無關的結果會淡化並排到最後。關閉時是一般的搜尋評分。",
  monitorProfile: "監測對象",
  monitorProfilePlaceholder:
    "例：客戶：台積電（TSMC），也常被稱為護國神山。產業：半導體晶圓代工，上下游包括 IC 設計、封裝測試、設備與材料。競爭對手：三星、英特爾。",
  monitorProfileHint:
    "寫客戶的名稱、簡稱或英文名、所屬產業，以及要一併留意的競爭對手或上下游，最多 2000 字。這段文字會送到你的 Worker 和 Jev 判斷；沒填的話，新聞監測模式不會啟用。",
  jobProfile: "求職條件（104 職缺評分用）",
  jobProfilePlaceholder:
    "例：20 年行政與會計經驗，熟悉 Excel、ERP 系統。希望在台北市中正區或大安區，日班、不輪班，不要粗重工作，月薪 4 萬以上，可接受部分遠端。",
  jobProfileHint:
    "用自己的話寫背景、專長和期望的工作條件即可，最多 2000 字。這段文字會送到你的 Worker 和 Jev 評分；留空的話，104 只依搜尋條件和中高齡友善程度評分。",
  save: "儲存",
  saved: "已儲存",
});

function applyLanguage() {
  document.documentElement.lang = uiLang === "zh" ? "zh-Hant" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = L(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = L(el.dataset.i18nPlaceholder);
  if ($("status").textContent) $("status").textContent = L("saved");
  // Passages are only translated into Chinese, for the Chinese interface.
  $("translateOption").hidden = uiLang !== "zh";
}
applyLanguage();
i18nReady.then(applyLanguage);

// The language applies at once, like fast mode, so the page can be read in it before saving.
chrome.storage.sync.get({ uiLanguage: "auto" }).then((v) => ($("uiLanguage").value = v.uiLanguage));
$("uiLanguage").onchange = async (e) => {
  await chrome.storage.sync.set({ uiLanguage: e.target.value });
  uiLang = resolveLang(e.target.value);
  applyLanguage();
};

chrome.storage.sync.get(DEFAULTS).then((v) => {
  $("workerUrl").value = v.workerUrl;
  $("token").value = v.token;
  $("jobProfile").value = v.jobProfile;
  $("reorder").checked = v.reorder;
  $("autoTranslate").checked = v.autoTranslate;
  $("monitorMode").checked = v.monitorMode;
  $("monitorProfile").value = v.monitorProfile;
});

$("save").onclick = async () => {
  await chrome.storage.sync.set({
    workerUrl: $("workerUrl").value.trim(),
    token: $("token").value,
    jobProfile: $("jobProfile").value.trim(),
    reorder: $("reorder").checked,
    autoTranslate: $("autoTranslate").checked,
    monitorMode: $("monitorMode").checked,
    monitorProfile: $("monitorProfile").value.trim(),
  });
  $("status").textContent = L("saved");
};

// Fast mode is the optional <all_urls> permission itself, so it applies at once and Chrome's
// own record of it is the only state. Requesting it needs this click (a user gesture).
const ALL_SITES = { origins: ["<all_urls>"] };
chrome.permissions.contains(ALL_SITES).then((on) => ($("fastMode").checked = on));
$("fastMode").onchange = async (e) => {
  const ok = e.target.checked ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES);
  if (!ok) e.target.checked = !e.target.checked; // the user declined, or Chrome refused
};
