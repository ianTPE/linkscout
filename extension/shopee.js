// Isolated world only: read rendered text without changing the page, wrapping
// network APIs, reading page state, or emitting window messages.
(() => {
  const saved = new Map(); // row key → last saved JSON
  const savedItems = new Set(); // shopid:itemid, for the toolbar count
  const recent = []; // last saved rows, for the toolbar popup
  let timer;
  let sending = false;
  let retryAfter = 0;
  let failed = false;
  let lastStatus = "";
  let pending = ""; // an option row read once, waiting for a second read to agree

  function productUrl(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== "https://shopee.tw") return null;
      const ids = url.pathname.match(/^\/product\/(\d+)\/(\d+)\/?$/) ??
        url.pathname.match(/-i\.(\d+)\.(\d+)\/?$/);
      return ids ? { shopid: ids[1], itemid: ids[2], url: `https://shopee.tw/product/${ids[1]}/${ids[2]}` } : null;
    } catch {
      return null;
    }
  }

  function visible(el) {
    if (!el || document.visibilityState !== "visible") return false;
    // display: contents has no box of its own (Shopee's card links); judge by its children.
    if (getComputedStyle(el).display === "contents") return [...el.children].some(visible);
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth &&
      style.visibility === "visible" && style.display !== "none";
  }

  // Visible and not marked aria-hidden (Shopee keeps duplicate hidden price copies).
  function shown(el) {
    return visible(el) && !el.closest('[aria-hidden="true"]');
  }

  // A struck-through amount is the old price shown next to a sale price.
  function struck(el) {
    const lined = (e) => (getComputedStyle(e).textDecorationLine ?? "").includes("line-through");
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) if (lined(e)) return true;
    return [...el.querySelectorAll("*")].some(lined);
  }

  const NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
  const CURRENCY = "(?:NT)?\\$";
  // Matched against an element's whole text with whitespace removed, because
  // Shopee splits "$" and the amount into separate flex items.
  const PRICE = new RegExp(`^${CURRENCY}(${NUMBER})(?:[-–~～](?:${CURRENCY})?(${NUMBER}))?$`, "i");

  // Adds node to found if its entire text is a TWD price/range. Nodes come in
  // document order, so an outer match comes first and covers the spans inside it.
  function addPrice(found, node) {
    if (found.some((f) => f.node.contains(node))) return;
    const text = node.textContent.replace(/\s+/g, "");
    if (PRICE.test(text) && shown(node) && !struck(node)) found.push({ node, text });
  }

  // Different visible prices (e.g. two prices without one struck through) are
  // ambiguous: skip rather than guess.
  function onePrice(found) {
    if (new Set(found.map((f) => f.text)).size !== 1) return null;
    const [, low, high] = found[0].text.match(PRICE);
    const price = Number(low.replaceAll(",", ""));
    const max = high ? Number(high.replaceAll(",", "")) : null;
    if (!Number.isFinite(price) || (max !== null && (!Number.isFinite(max) || max < price))) return null;
    return { price, price_max: max };
  }

  function priceIn(el) {
    const found = [];
    for (const node of [el, ...el.querySelectorAll("*")]) addPrice(found, node);
    return onePrice(found);
  }

  // "已售出 342" on search cards, "1,000+ 已售出" on product pages; 萬 is 10,000.
  // A "+" (lower bound) is recorded as the number shown.
  const SOLD = /^(?:已售出([\d,.]+)(萬)?\+?|([\d,.]+)(萬)?\+?已售出)$/;

  function soldFrom(text) {
    const m = text.replace(/\s+/g, "").match(SOLD);
    if (!m) return null;
    const n = Number((m[1] ?? m[3]).replaceAll(",", "")) * ((m[2] ?? m[4]) ? 10_000 : 1);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function soldIn(el) {
    for (const node of el.querySelectorAll("*")) {
      const n = soldFrom(node.textContent);
      if (n !== null && shown(node)) return n;
    }
    return null;
  }

  const LINKS = 'a[href*="-i."], a[href*="/product/"]';

  // Product pages: the prices and sales count after the title and before the next
  // heading or product link. Instalment, shipping and coupon amounts (e.g. a "$30"
  // late-delivery coupon) sit under later headings such as 分期0利率 and 運送.
  function afterTitle(heading) {
    const walker = document.createTreeWalker(document.body, 1 /* NodeFilter.SHOW_ELEMENT */);
    walker.currentNode = heading;
    const found = [];
    let sold = null;
    for (let node = walker.nextNode(), n = 0; node && n < 1000; node = walker.nextNode(), n++) {
      if (heading.contains(node)) continue;
      if (node.matches(`h1, h2, ${LINKS}`)) break;
      addPrice(found, node);
      if (sold === null) {
        const s = soldFrom(node.textContent);
        if (s !== null && shown(node)) sold = s;
      }
    }
    return { prices: onePrice(found), sold };
  }

  // Option buttons the person selected on a product page (Shopee marks them
  // selection-box-selected). Read only; nothing here clicks.
  function selectedOptions() {
    return [...document.querySelectorAll('button[class*="selection-box-selected"]')]
      .filter(shown)
      .map((b) => (b.getAttribute("aria-label") || b.textContent).trim())
      .filter(Boolean);
  }

  function ownText(el) {
    return [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  }

  // A card's name: its heading, or else the first visible text in the card (Shopee
  // search cards put the title in a plain div after a badge image). If that first
  // text is too short or is a price, skip the card rather than take later text
  // such as "已售出 10".
  function nameIn(el) {
    const heading = el.querySelector('h3, h2, [role="heading"]');
    if (heading) return visible(heading) ? heading.innerText.trim() : null;
    for (const node of el.querySelectorAll("*")) {
      const text = ownText(node);
      if (!text || !shown(node)) continue;
      return text.length >= 6 && !PRICE.test(text.replace(/\s+/g, "")) ? text : null;
    }
    return null;
  }

  function item(ids, name, prices, sold) {
    return { ...ids, name, ...prices, shop_name: null, sold, stock: null, location: null, official: null };
  }

  // Returns the rows to save and, on a product page, what was read there (for the popup).
  function collect() {
    const items = new Map();
    for (const link of document.querySelectorAll(LINKS)) {
      const ids = productUrl(link.href);
      if (!ids || !visible(link)) continue;
      // Rendered text only; never substitute hidden metadata/image alt.
      const name = nameIn(link);
      const prices = name && priceIn(link);
      if (prices) items.set(`${ids.shopid}:${ids.itemid}`, item(ids, name, prices, soldIn(link)));
    }

    const ids = productUrl(location.href);
    const heading = document.querySelector("h1");
    const name = ids && heading && shown(heading) ? heading.innerText.trim() : "";
    if (!name) return { items: [...items.values()], product: null, productRow: null };
    const { prices, sold } = afterTitle(heading);
    const options = selectedOptions();
    const product = { name, price: prices?.price ?? null, price_max: prices?.price_max ?? null, sold, options, variant: null };
    let productRow = null;
    if (prices && !options.length) {
      productRow = item(ids, name, prices, sold);
    } else if (prices && prices.price_max === null) {
      // With options selected the page shows that option's price. Saved as a
      // one-option variants row; the monitor merges options picked one at a time.
      product.variant = { name: options.join(" / "), price: prices.price, in_stock: null };
      productRow = { ...ids, kind: "variants", partial: true, name, sold, variants: [product.variant] };
    }
    if (productRow) items.set(rowKey(productRow), productRow);
    return { items: [...items.values()], product, productRow };
  }

  function rowKey(row) {
    return row.kind === "variants" ? `${row.shopid}:${row.itemid}:${row.variants[0].name}` : `${row.shopid}:${row.itemid}`;
  }

  // Toolbar badge and popup only: no status nodes/attributes added to the page.
  function report(product, productRow) {
    if (product) product.saved = !!productRow && saved.get(rowKey(productRow)) === JSON.stringify(productRow);
    const status = { type: "shopeeStatus", total: savedItems.size, error: failed, product, recent: recent.slice(-8) };
    const json = JSON.stringify(status);
    if (json === lastStatus) return;
    lastStatus = json;
    chrome.runtime.sendMessage(status).catch(() => {});
  }

  async function scan() {
    timer = undefined;
    if (sending || document.visibilityState !== "visible") return;
    let { items, product, productRow } = collect();
    // Shopee marks a newly selected option before it updates the price, so one read
    // can pair the new option with the old price. Save an option only once the next
    // read agrees.
    if (productRow?.kind === "variants") {
      const json = JSON.stringify(productRow);
      if (json !== pending) {
        pending = json;
        items = items.filter((row) => row !== productRow);
        productRow = null;
        schedule();
      }
    }
    const fresh = items.filter((row) => saved.get(rowKey(row)) !== JSON.stringify(row));
    if (!fresh.length || Date.now() < retryAfter) return report(product, productRow);
    sending = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "shopeeCapture", page: location.href, items: fresh });
      if (!result?.ok) throw new Error("Local receiver unavailable");
      failed = false;
      for (const row of fresh) {
        saved.set(rowKey(row), JSON.stringify(row));
        savedItems.add(`${row.shopid}:${row.itemid}`);
        recent.push({ name: row.name, price: row.kind === "variants" ? row.variants[0].price : row.price,
          price_max: row.kind === "variants" ? null : row.price_max, sold: row.sold,
          variant: row.kind === "variants" ? row.variants[0].name : null });
      }
      recent.splice(0, recent.length - 8);
    } catch {
      failed = true;
      retryAfter = Date.now() + 30_000;
      // Retry on a later page/scroll event; no messages in the page console.
    } finally {
      sending = false;
    }
    report(product, productRow);
  }

  function schedule() {
    if (timer === undefined) timer = setTimeout(scan, 1200);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", schedule);
  schedule();
})();
