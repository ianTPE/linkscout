// Shopee capture: turns the product JSON that shopee-hook.js copied from the page into compact
// rows (item, shop, price, sold) and sends them to the local product monitor through the
// background script. Only what the person actually browsed is recorded.

(() => {
  const seen = new Set();
  let total = 0;
  let badge;

  /** Pull every object that looks like a product (has itemid + shopid + a name + a price). */
  function products(node, out = [], shopNames = {}) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const x of node) products(x, out, shopNames);
      return out;
    }
    const b = node.item_basic ?? node;
    if (b.itemid && b.shopid && (b.name || b.title) && (b.price ?? b.price_min) != null) {
      out.push(b);
    } else {
      for (const v of Object.values(node)) products(v, out, shopNames);
    }
    return out;
  }

  function rows(data) {
    // Product page: the shop's name sits next to the item, not inside it.
    const pageShop = data?.data?.shop_detailed?.name ?? data?.data?.shop_info?.name;
    return products(data).map((b) => ({
      itemid: String(b.itemid),
      shopid: String(b.shopid),
      shop_name: b.shop_name ?? pageShop ?? null,
      name: b.name ?? b.title,
      price: (b.price ?? b.price_min) / 100000,
      price_max: b.price_max != null ? b.price_max / 100000 : null,
      sold: b.historical_sold ?? b.sold ?? null,
      stock: b.stock ?? null,
      location: b.shop_location ?? null,
      official: b.is_official_shop ?? null,
      url: `https://shopee.tw/product/${b.shopid}/${b.itemid}`,
    }));
  }

  /** Product page: every option (規格) with its own price, from the item's `models` list. */
  function variantRows(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const x of node) variantRows(x, out);
      return out;
    }
    const itemid = node.itemid ?? node.item_id;
    const shopid = node.shopid ?? node.shop_id;
    if (itemid && shopid && Array.isArray(node.models) && node.models.length) {
      const price = (m) => m.price ?? m.price_info?.price ?? m.price_min ?? null;
      out.push({
        itemid: String(itemid),
        shopid: String(shopid),
        name: node.name ?? node.title ?? null,
        stock_display: node.stock_display ?? null, // e.g. "售完" or the number left
        variants: node.models
          .filter((m) => price(m) != null)
          .map((m) => ({
            modelid: String(m.modelid ?? m.model_id ?? ""),
            name: m.name ?? null,
            price: price(m) / 100000,
            in_stock: m.has_stock ?? m.stock_info?.has_stock ?? null,
          })),
        url: `https://shopee.tw/product/${shopid}/${itemid}`,
      });
      return out;
    }
    for (const v of Object.values(node)) variantRows(v, out);
    return out;
  }

  function send(items, onSaved) {
    chrome.runtime.sendMessage({ type: "shopeeCapture", page: location.href, items }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        console.warn("[LinkScout] Shopee capture not saved:", chrome.runtime.lastError?.message ?? res?.error);
        return;
      }
      onSaved();
    });
  }

  let variantNote = "";

  function showBadge() {
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText =
        "position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border-radius:6px;" +
        "background:#1f6f43;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px #0003;pointer-events:none";
      document.documentElement.appendChild(badge);
    }
    badge.textContent = `LinkScout 已記錄 ${total} 件蝦皮商品${variantNote}`;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "linkscout-shopee") return;
    // Options first: on a product page the same item also shows up as a plain row, and the
    // plain row would otherwise mark it as already seen.
    const pageShop = e.data.data?.data?.shop_detailed?.name ?? e.data.data?.data?.shop_info?.name ?? null;
    const withVariants = variantRows(e.data.data).filter(
      (r) => r.variants.length && !seen.has(`${r.itemid}:v`) && seen.add(`${r.itemid}:v`),
    );
    if (withVariants.length) {
      send(withVariants.map((r) => ({ ...r, shop_name: pageShop, kind: "variants" })), () => {
        const n = withVariants.reduce((a, r) => a + r.variants.length, 0);
        variantNote = `（這頁 ${n} 個規格的價格已記錄）`;
        showBadge();
      });
    }
    const fresh = rows(e.data.data).filter((r) => !seen.has(r.itemid) && seen.add(r.itemid));
    if (!fresh.length) return;
    send(fresh, () => {
      total += fresh.length;
      showBadge();
    });
  });
})();
