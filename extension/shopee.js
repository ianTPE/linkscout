// Isolated world only: read rendered text without changing the page, wrapping
// network APIs, reading page state, or emitting window messages.
(() => {
  const saved = new Map();
  let total = 0;
  let timer;
  let sending = false;
  let retryAfter = 0;

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
    if (PRICE.test(text) && shown(node)) found.push({ node, text });
  }

  // Different visible prices (e.g. a sale plus the old price) are ambiguous:
  // skip rather than guess.
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

  const LINKS = 'a[href*="-i."], a[href*="/product/"]';

  // Product pages: the prices after the title and before the next heading or
  // product link. Instalment, shipping and coupon amounts (e.g. a "$30" late-
  // delivery coupon) sit under later headings such as 分期0利率 and 運送.
  function priceAfter(heading) {
    const walker = document.createTreeWalker(document.body, 1 /* NodeFilter.SHOW_ELEMENT */);
    walker.currentNode = heading;
    const found = [];
    for (let node = walker.nextNode(), n = 0; node && n < 1000; node = walker.nextNode(), n++) {
      if (heading.contains(node)) continue;
      if (node.matches(`h1, h2, ${LINKS}`)) break;
      addPrice(found, node);
    }
    return onePrice(found);
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

  function row(el, ids, name) {
    if (!visible(el) || !name) return null;
    const prices = priceIn(el);
    if (!prices) return null;
    return { ...ids, name, ...prices, shop_name: null, sold: null, stock: null,
      location: null, official: null };
  }

  function collect() {
    const items = new Map();
    for (const link of document.querySelectorAll(LINKS)) {
      const ids = productUrl(link.href);
      if (!ids || !visible(link)) continue;
      // Rendered text only; never substitute hidden metadata/image alt.
      const item = row(link, ids, nameIn(link));
      if (item) items.set(`${item.shopid}:${item.itemid}`, item);
    }

    const ids = productUrl(location.href);
    const heading = document.querySelector("h1");
    const name = heading && shown(heading) ? heading.innerText.trim() : "";
    const prices = ids && name ? priceAfter(heading) : null;
    if (prices) {
      items.set(`${ids.shopid}:${ids.itemid}`, { ...ids, name, ...prices, shop_name: null, sold: null,
        stock: null, location: null, official: null });
    }
    return [...items.values()];
  }

  async function scan() {
    timer = undefined;
    if (sending || document.visibilityState !== "visible" || Date.now() < retryAfter) return;
    const items = collect().filter((item) => saved.get(`${item.shopid}:${item.itemid}`) !== JSON.stringify(item));
    if (!items.length) return;
    sending = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "shopeeCapture", page: location.href, items });
      if (!result?.ok) throw new Error("Local receiver unavailable");
      for (const item of items) {
        const key = `${item.shopid}:${item.itemid}`;
        if (!saved.has(key)) total++;
        saved.set(key, JSON.stringify(item));
      }
      // Browser toolbar only: no status nodes/attributes added to the page.
      await chrome.runtime.sendMessage({ type: "shopeeStatus", total });
    } catch {
      retryAfter = Date.now() + 30_000;
      chrome.runtime.sendMessage({ type: "shopeeStatus", error: true }).catch(() => {});
      // Retry on a later page/scroll event; no messages in the page console.
    } finally {
      sending = false;
    }
  }

  function schedule() {
    if (timer === undefined) timer = setTimeout(scan, 1200);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", schedule);
  schedule();
})();
