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
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth &&
      style.visibility === "visible" && style.display !== "none";
  }

  // Only an entire line containing a TWD price/range qualifies. Multiple price
  // lines (e.g. a sale plus the old price) are ambiguous: skip rather than guess.
  function priceFromText(text) {
    const number = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
    const currency = "(?:NT\\s*)?\\$";
    const pattern = new RegExp(`^${currency}\\s*(${number})(?:\\s*[-–~～]\\s*(?:${currency}\\s*)?(${number}))?$`, "i");
    const prices = text.split(/\n/).map((line) => line.trim()).filter(Boolean)
      .map((line) => line.match(pattern)).filter(Boolean);
    if (prices.length !== 1) return null;
    const price = Number(prices[0][1].replaceAll(",", ""));
    const max = prices[0][2] ? Number(prices[0][2].replaceAll(",", "")) : null;
    if (!Number.isFinite(price) || (max !== null && (!Number.isFinite(max) || max < price))) return null;
    return { price, price_max: max };
  }

  function row(el, ids, name) {
    if (!visible(el) || !name) return null;
    const prices = priceFromText(el.innerText);
    if (!prices) return null;
    return { ...ids, name, ...prices, shop_name: null, sold: null, stock: null,
      location: null, official: null };
  }

  function collect() {
    const items = new Map();
    for (const link of document.querySelectorAll('a[href*="-i."], a[href*="/product/"]')) {
      const ids = productUrl(link.href);
      if (!ids || !visible(link)) continue;
      // Require a visible heading; never substitute hidden metadata/image alt.
      const heading = link.querySelector('h3, h2, [role="heading"]');
      if (!visible(heading)) continue;
      const item = row(link, ids, heading.innerText.trim());
      if (item) items.set(`${item.shopid}:${item.itemid}`, item);
    }

    const ids = productUrl(location.href);
    const heading = document.querySelector("h1");
    if (ids && visible(heading)) {
      // Search a few parents for a sibling price, stopping before recommendations.
      let section = heading.parentElement;
      for (let depth = 0; section && depth < 4; depth++, section = section.parentElement) {
        if (section === document.body || section === document.documentElement ||
            section.querySelector('a[href*="-i."], a[href*="/product/"]')) break;
        const item = row(section, ids, heading.innerText.trim());
        if (item) {
          items.set(`${item.shopid}:${item.itemid}`, item);
          break;
        }
      }
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
