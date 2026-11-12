// Reddit pages (www.reddit.com and old.reddit.com): records the posts the person scrolled
// past (subreddit, title, score, comment count, time) for the local receiver, which
// hn-daily turns into a daily list of new and popular threads.
// Reads attributes Reddit already put on the rendered posts; never fetches anything,
// follows links, clicks or scrolls. Promoted posts are skipped.

const REDDIT_ORIGINS = ["https://www.reddit.com", "https://old.reddit.com"];

/** The listing a page shows ("r/LocalLLaMA/top"), or null for pages that are not on Reddit. */
function redditListing(href) {
  try {
    const url = new URL(href);
    if (!REDDIT_ORIGINS.includes(url.origin)) return null;
    return url.pathname.replace(/^\/+|\/+$/g, "") || "home";
  } catch {
    return null;
  }
}

/** A whole number from an attribute ("123", "-4"); anything else is null. */
function redditInt(v) {
  return typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null;
}

/** One post: { id, subreddit, title, url, link, author, created, score, comments }; null if not a post. */
function redditRow(el, base) {
  const a = (n) => el.getAttribute(n);
  let row;
  if (el.tagName === "SHREDDIT-POST") {
    row = {
      id: a("id"), subreddit: a("subreddit-prefixed-name"), title: a("post-title"), permalink: a("permalink"),
      link: a("content-href"), author: a("author"), created: a("created-timestamp"),
      score: redditInt(a("score")), comments: redditInt(a("comment-count")),
    };
  } else {
    if (a("data-promoted") === "true") return null;
    const ms = redditInt(a("data-timestamp"));
    row = {
      id: a("data-fullname"), subreddit: a("data-subreddit-prefixed") ?? (a("data-subreddit") ? `r/${a("data-subreddit")}` : null),
      title: el.querySelector("a.title")?.textContent.trim() ?? null, permalink: a("data-permalink"),
      link: a("data-url"), author: a("data-author"), created: ms == null ? null : new Date(ms).toISOString(),
      score: redditInt(a("data-score")), comments: redditInt(a("data-comments-count")),
    };
  }
  if (!/^t3_\w+$/.test(row.id ?? "") || !row.title || !row.permalink?.startsWith("/r/")) return null;
  const { permalink, ...rest } = row;
  const url = new URL(permalink, "https://www.reddit.com").href;
  let link = null;
  try { link = row.link ? new URL(row.link, base).href : null; } catch {}
  return { ...rest, title: row.title.trim(), url, link: link === url ? null : link };
}

const REDDIT_POSTS = "shreddit-post, div.thing.link[data-fullname]";

// Comments on a post page (new Reddit only): each loaded <shreddit-comment> carries its
// id, post, parent, depth, author, score and time as attributes; the text is the element
// with id "<comment id>-comment-rtjson-content". Only comments already on screen are
// read; "more replies" is never clicked, so a long thread is recorded only in part.
const REDDIT_COMMENTS = "shreddit-comment";
const COMMENT_TEXT_MAX = 2000;

/** One comment: { id, post, parent, depth, author, score, created, url, text }; null if not a comment. */
function redditComment(el, doc) {
  const a = (n) => el.getAttribute(n);
  const id = a("thingid");
  const post = a("postid");
  const permalink = a("permalink");
  if (!/^t1_\w+$/.test(id ?? "") || !/^t3_\w+$/.test(post ?? "") || !permalink?.startsWith("/r/")) return null;
  const text = doc.getElementById(`${id}-comment-rtjson-content`)?.innerText?.trim() || null;
  return {
    id, post, parent: a("parentid") || post, depth: redditInt(a("depth")), author: a("author"),
    score: redditInt(a("score")), created: a("created"), url: new URL(permalink, "https://www.reddit.com").href,
    text: text && text.slice(0, COMMENT_TEXT_MAX),
  };
}

if (typeof module !== "undefined") {
  module.exports = { redditListing, redditInt, redditRow, redditComment, REDDIT_POSTS };
} else {
  (() => {
    const sent = new Map(); // post id → "score/comments" already sent from this page
    let timer;
    let page = location.href;

    function stop() {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      clearTimeout(timer);
    }

    function scan() {
      timer = undefined;
      if (!globalThis.chrome?.runtime?.id) return stop(); // extension reloaded; a refresh starts the new script
      if (location.href !== page) { page = location.href; sent.clear(); } // Reddit navigates without reloading
      const listing = redditListing(location.href);
      if (!listing || document.visibilityState !== "visible") return;
      const posts = [...document.querySelectorAll(REDDIT_POSTS)]
        .map((el) => redditRow(el, location.href))
        .filter((p) => p && sent.get(p.id) !== `${p.score}/${p.comments}`);
      const comments = [...document.querySelectorAll(REDDIT_COMMENTS)]
        .map((el) => redditComment(el, document))
        .filter((c) => c && sent.get(c.id) !== `${c.score}/${c.text?.length}`);
      try {
        if (posts.length) {
          chrome.runtime.sendMessage({ type: "redditCapture", page: location.href, listing, posts })
            .then((res) => { if (res?.ok) posts.forEach((p) => sent.set(p.id, `${p.score}/${p.comments}`)); }, () => {});
        }
        if (comments.length) {
          chrome.runtime.sendMessage({ type: "redditComments", page: location.href, comments })
            .then((res) => { if (res?.ok) comments.forEach((c) => sent.set(c.id, `${c.score}/${c.text?.length}`)); }, () => {});
        }
      } catch {
        stop();
      }
    }

    function schedule() {
      if (timer === undefined) timer = setTimeout(scan, 1500);
    }

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    schedule();
  })();
}
