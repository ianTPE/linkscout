// Runs in the Shopee page's own world. It never sends a request of its own: it only copies
// the product JSON that Shopee's page already fetched while the person browses, and hands it
// to shopee.js through window.postMessage.

(() => {
  const WATCH = /\/api\/v4\/(search\/search_items|pdp\/get_pc|pdp\/get|shop\/rcmd_items|shop\/search_items|recommend\/recommend)/;
  const post = (url, data) => window.postMessage({ source: "linkscout-shopee", url, data }, location.origin);

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && WATCH.test(url)) res.clone().json().then((d) => post(url, d), () => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string" && WATCH.test(url)) {
      this.addEventListener("load", () => {
        try {
          const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          post(url, d);
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
