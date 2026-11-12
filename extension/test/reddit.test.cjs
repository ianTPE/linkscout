const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redditListing, redditInt, redditRow, redditComment } = require("../reddit.js");

test("listings on Reddit only", () => {
  assert.equal(redditListing("https://www.reddit.com/r/LocalLLaMA/top/?t=day"), "r/LocalLLaMA/top");
  assert.equal(redditListing("https://old.reddit.com/r/esp32/"), "r/esp32");
  assert.equal(redditListing("https://www.reddit.com/"), "home");
  assert.equal(redditListing("https://evil.example/r/x"), null);
  assert.equal(redditListing("not a url"), null);
});

test("integers", () => {
  assert.equal(redditInt("123"), 123);
  assert.equal(redditInt(" -4 "), -4);
  assert.equal(redditInt("1.2k"), null);
  assert.equal(redditInt(null), null);
});

function el(tag, attrs, title) {
  return {
    tagName: tag, getAttribute: (n) => attrs[n] ?? null,
    querySelector: (s) => (s === "a.title" && title != null ? { textContent: title } : null),
  };
}

const base = "https://www.reddit.com/r/LocalLLaMA/";

test("new Reddit posts", () => {
  assert.deepEqual(redditRow(el("SHREDDIT-POST", {
    id: "t3_1abc", "subreddit-prefixed-name": "r/LocalLLaMA", "post-title": " Qwen 4 is out ",
    permalink: "/r/LocalLLaMA/comments/1abc/qwen_4_is_out/", "content-href": "https://qwen.ai/blog",
    author: "someone", "created-timestamp": "2026-11-11T03:00:00.000000+0000", score: "512", "comment-count": "88",
  }), base), {
    id: "t3_1abc", subreddit: "r/LocalLLaMA", title: "Qwen 4 is out", url: "https://www.reddit.com/r/LocalLLaMA/comments/1abc/qwen_4_is_out/",
    link: "https://qwen.ai/blog", author: "someone", created: "2026-11-11T03:00:00.000000+0000", score: 512, comments: 88,
  });
  // A text post links to itself: no separate link.
  const self = redditRow(el("SHREDDIT-POST", {
    id: "t3_2", "subreddit-prefixed-name": "r/x", "post-title": "t", permalink: "/r/x/comments/2/t/",
    "content-href": "https://www.reddit.com/r/x/comments/2/t/", score: "", "comment-count": "0",
  }), base);
  assert.equal(self.link, null);
  assert.equal(self.score, null);
  assert.equal(self.comments, 0);
});

test("old Reddit posts", () => {
  assert.deepEqual(redditRow(el("DIV", {
    "data-fullname": "t3_9z", "data-subreddit": "esp32", "data-permalink": "/r/esp32/comments/9z/x/",
    "data-url": "/r/esp32/comments/9z/x/", "data-author": "a", "data-timestamp": "1794300000000",
    "data-score": "40", "data-comments-count": "7",
  }, "My ESP32 clock"), "https://old.reddit.com/r/esp32/"), {
    id: "t3_9z", subreddit: "r/esp32", title: "My ESP32 clock", url: "https://www.reddit.com/r/esp32/comments/9z/x/",
    link: "https://old.reddit.com/r/esp32/comments/9z/x/", author: "a", created: new Date(1794300000000).toISOString(), score: 40, comments: 7,
  });
  assert.equal(redditRow(el("DIV", { "data-fullname": "t3_ad", "data-promoted": "true", "data-permalink": "/r/x/comments/ad/" }, "Ad"), base), null);
});

test("not posts", () => {
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t1_comment", "post-title": "t", permalink: "/r/x/comments/1/" }), base), null);
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t3_1", "post-title": "", permalink: "/r/x/comments/1/" }), base), null);
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t3_1", "post-title": "t", permalink: "https://evil.example/" }), base), null);
});

function comment(attrs) {
  return { getAttribute: (n) => attrs[n] ?? null };
}
const doc = (texts) => ({ getElementById: (id) => (id in texts ? { innerText: texts[id] } : null) });

test("comments on a post page", () => {
  // Attributes as saved from a real r/ClaudeAI thread (2026-11-12).
  const reply = comment({
    thingid: "t1_19sfsdjum0poi", postid: "t3_1xsudl0", parentid: "t1_19sfrk5zkkmps", depth: "1",
    author: "neuronexmachina", score: "16", created: "2026-11-10T18:47:56.541000+0000",
    permalink: "/r/ClaudeAI/comments/1xsudl0/comment/19sfsdjum0poi/",
  });
  assert.deepEqual(redditComment(reply, doc({ "t1_19sfsdjum0poi-comment-rtjson-content": "  Probably a postinstall script.\n" })), {
    id: "t1_19sfsdjum0poi", post: "t3_1xsudl0", parent: "t1_19sfrk5zkkmps", depth: 1, author: "neuronexmachina",
    score: 16, created: "2026-11-10T18:47:56.541000+0000",
    url: "https://www.reddit.com/r/ClaudeAI/comments/1xsudl0/comment/19sfsdjum0poi/", text: "Probably a postinstall script.",
  });
  // A top-level comment's parent is the post; a comment without text keeps text null.
  const top = redditComment(comment({ thingid: "t1_a", postid: "t3_p", depth: "0", permalink: "/r/x/comments/p/comment/a/" }), doc({}));
  assert.equal(top.parent, "t3_p");
  assert.equal(top.text, null);
  // Long text is cut.
  const long = redditComment(comment({ thingid: "t1_b", postid: "t3_p", permalink: "/r/x/comments/p/comment/b/" }), doc({ "t1_b-comment-rtjson-content": "x".repeat(5000) }));
  assert.equal(long.text.length, 2000);
  assert.equal(redditComment(comment({ thingid: "t3_p", postid: "t3_p", permalink: "/r/x/" }), doc({})), null);
  assert.equal(redditComment(comment({ thingid: "t1_c", postid: "t3_p", permalink: "https://evil.example/" }), doc({})), null);
});
