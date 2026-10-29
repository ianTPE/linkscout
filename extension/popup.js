// Toolbar popup: what the Shopee capture recorded in the current tab (stored by
// background.js). Page text is shown with textContent only.

const out = document.getElementById("out");

function add(parent, tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  parent.append(el);
  return el;
}

const money = (n) => `$${n.toLocaleString("en-US")}`;
const priceText = (r) => r.price == null ? "看不出價格" : r.price_max != null ? `${money(r.price)} – ${money(r.price_max)}` : money(r.price);
const soldText = (r) => r.sold != null ? `，已售出 ${r.sold.toLocaleString("en-US")}` : "";

function product(p) {
  const box = add(out, "div", null, "box");
  add(box, "span", p.name, "name");
  add(box, "p", `價格：${priceText(p)}${soldText(p)}`);
  if (p.variant) {
    add(box, "p", p.saved ? `✅ 規格「${p.variant.name}」${money(p.variant.price)} 已記錄` : `規格「${p.variant.name}」${money(p.variant.price)} 確認中，價格穩定後就會記下…`,
      p.saved ? "ok" : "warn");
  } else if (p.options.length) {
    add(box, "p", `已選「${p.options.join(" / ")}」，但價格還是範圍或看不出來：請把其他規格也選好。`, "warn");
  } else if (p.price == null) {
    add(box, "p", "這一頁看不出單一價格（例如同時顯示兩個價格），沒有記錄。", "warn");
  } else {
    add(box, "p", p.saved ? "✅ 整頁價格已記錄" : "整頁價格還在儲存…", p.saved ? "ok" : "warn");
    add(box, "p", p.price_max != null
      ? "要記錄某個規格的價格：在頁面上點選那個規格（例如 10ml），價格變成單一價格後就會記下來。"
      : "要記錄某個規格的價格，在頁面上點選那個規格即可。", "muted");
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = `shopee:${tab?.id}`;
  const s = (await chrome.storage.session.get(key))[key];
  if (!s) {
    add(out, "p", "這個分頁還沒有記到蝦皮商品。", "muted");
    add(out, "p", "LinkScout 只在 shopee.tw 頁面記錄您畫面上看得到的商品；搜尋結果要往下捲，看到的商品才會記下來。", "muted");
    return;
  }
  if (s.error) add(out, "p", "⚠️ 本機接收器連不上（product-monitor-receiver），最近讀到的資料還沒存，30 秒後會再試。", "err");
  add(out, "p", `這一頁瀏覽期間共記錄 ${s.total} 件商品。`, s.total ? "ok" : "muted");
  if (s.product) product(s.product);
  if (s.recent.length) {
    add(out, "p", "最近記下的：", "muted");
    const ul = add(out, "ul");
    for (const r of s.recent.slice().reverse()) {
      const li = add(ul, "li");
      add(li, "span", r.name, "name");
      add(li, "span", (r.variant ? `規格「${r.variant}」 ` : "") + priceText(r) + soldText(r), "muted");
    }
  }
  add(out, "p", `更新於 ${new Date(s.at).toLocaleTimeString("zh-TW")}`, "muted");
}

main();
